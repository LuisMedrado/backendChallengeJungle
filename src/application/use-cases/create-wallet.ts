import { Money, type MoneyProps } from '../../domain/money/money';
import { WagerTransaction } from '../../domain/wagering/wager-transaction';
import { Wallet } from '../../domain/wallet/wallet';
import { DuplicateKeyError, WalletAlreadyExistsError } from '../errors';
import { type EventTrace, outboxMessagesFor } from '../events';
import type { Clock, IdGenerator, UnitOfWork } from '../ports';

export interface CreateWalletCommand {
  playerId: string;
  initialBalance: MoneyProps;
  trace: EventTrace;
}

export class CreateWallet {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  async execute(command: CreateWalletCommand): Promise<Wallet> {
    const initialBalance = Money.from(command.initialBalance);

    try {
      return await this.uow.transactional(async (scope) => {
        const now = this.clock.now();
        const openingTransactionId = this.ids.next();
        const { wallet, openingEntry } = Wallet.open({
          id: this.ids.next(),
          playerId: command.playerId,
          initialBalance,
          openingTransactionId,
          openingLedgerEntryId: this.ids.next(),
          at: now,
        });
        await scope.wallets.insert(wallet);

        // saldo inicial > 0 vira transação OPENING + CREDIT no ledger, na msm transação SQL
        if (openingEntry) {
          const opening = WagerTransaction.createOpening({
            id: openingTransactionId,
            walletId: wallet.id,
            playerId: wallet.playerId,
            money: initialBalance,
            createdAt: now,
          });
          await scope.transactions.insert(opening);
          await scope.ledger.insert(openingEntry);
          await scope.outbox.add(outboxMessagesFor(opening, wallet, openingEntry, command.trace, this.ids, this.clock));
        }
        return wallet;
      });
    } catch (error) {
      if (error instanceof DuplicateKeyError && error.constraint === 'wallets_player_currency_uk') {
        throw new WalletAlreadyExistsError(command.playerId, initialBalance.currency);
      }
      throw error;
    }
  }
}
