import { Money, type MoneyProps } from '../../domain/money/money';
import { InvalidWagerTransactionError } from '../../domain/shared/errors';
import { WagerSettlement } from '../../domain/wagering/wager-settlement';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../domain/wagering/wager-transaction';
import { DuplicateKeyError, IdempotencyConflictError, WalletNotFoundError } from '../errors';
import { type EventTrace, outboxMessagesFor } from '../events';
import { computePayloadHash } from '../idempotency/payload-hash';
import type { Clock, IdGenerator, TransactionScope, UnitOfWork } from '../ports';

export interface ProcessWagerCommand {
  idempotencyKey: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
  trace: EventTrace;
}

export interface ProcessWagerResult {
  transaction: WagerTransaction;
  idempotentReplay: boolean;
}

// kinds que podem vir de fora, OPENING é interno
const SUBMITTABLE_KINDS: ReadonlySet<string> = new Set([
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Loss,
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
]);

// type guard em vez de cast, o compilador garante o tipo depois da checagem
function isSubmittableKind(kind: string): kind is WagerTransactionKind {
  return SUBMITTABLE_KINDS.has(kind);
}

// unique que indica corrida entre duas requisições da msm operação
const IDEMPOTENCY_CONSTRAINTS: ReadonlySet<string> = new Set([
  'wager_tx_idempotency_key_uk',
  'wager_tx_provider_external_uk',
]);

// use case único pra entrada http e pela fila
export class ProcessWagerTransaction {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  async execute(command: ProcessWagerCommand): Promise<ProcessWagerResult> {
    // valida tudo que dá antes de abrir transação, payload ruim nem chega no banco
    const money = Money.from(command.money);
    const { kind } = command;
    if (!isSubmittableKind(kind)) {
      throw new InvalidWagerTransactionError(`kind ${kind} não pode ser submetido`);
    }
    const payloadHash = computePayloadHash(command);

    try {
      return await this.attempt(command, kind, money, payloadHash);
    } catch (error) {
      // duas requisições da msm operação passaram pela checagem ao msm tempo
      // a unique do banco barrou a segunda, na nova tentativa ela acha a primeira
      if (error instanceof DuplicateKeyError && error.constraint && IDEMPOTENCY_CONSTRAINTS.has(error.constraint)) {
        return this.attempt(command, kind, money, payloadHash);
      }
      throw error;
    }
  }

  private attempt(
    command: ProcessWagerCommand,
    kind: WagerTransactionKind,
    money: Money,
    payloadHash: string,
  ): Promise<ProcessWagerResult> {
    return this.uow.transactional(async (scope) => {
      // lock por wallet: toda operação da msm wallet passa por aqui em fila, wallets diferentes em paralelo
      const wallet = await scope.wallets.lockById(command.walletId);
      if (!wallet) throw new WalletNotFoundError(command.walletId);

      const existing = await this.findExisting(scope, command);
      if (existing) {
        if (existing.idempotencyKey !== command.idempotencyKey || !existing.matchesPayload(payloadHash)) {
          throw new IdempotencyConflictError(command.idempotencyKey);
        }
        return { transaction: existing, idempotentReplay: true };
      }

      const now = this.clock.now();
      const transaction = WagerTransaction.create({
        id: this.ids.next(),
        providerId: command.providerId,
        externalTransactionId: command.externalTransactionId,
        idempotencyKey: command.idempotencyKey,
        payloadHash,
        walletId: command.walletId,
        playerId: command.playerId,
        roundId: command.roundId,
        gameId: command.gameId,
        kind,
        money,
        referenceExternalTransactionId: command.referenceExternalTransactionId || undefined,
        createdAt: now,
      });

      const reference = transaction.referenceExternalTransactionId
        ? await scope.transactions.findByExternalId(transaction.providerId, transaction.referenceExternalTransactionId)
        : undefined;
      const referenceAlreadyReversed =
        reference && transaction.isReversal()
          ? await scope.transactions.hasProcessedReversal(reference.id, transaction.kind)
          : false;

      const versionBefore = wallet.version;
      const result = WagerSettlement.settle({
        transaction,
        wallet,
        reference,
        referenceAlreadyReversed,
        ledgerEntryId: this.ids.next(),
        now,
      });

      // transação, saldo, ledger e outbox na msm transação SQL
      await scope.transactions.insert(transaction);
      const ledgerEntry = result.status === WagerTransactionStatus.Processed ? result.ledgerEntry : undefined;
      if (ledgerEntry) {
        await scope.wallets.saveBalance(wallet, versionBefore);
        await scope.ledger.insert(ledgerEntry);
      }
      await scope.outbox.add(outboxMessagesFor(transaction, wallet, ledgerEntry, command.trace, this.ids, this.clock));

      return { transaction, idempotentReplay: false };
    });
  }

  private async findExisting(scope: TransactionScope, command: ProcessWagerCommand) {
    return (
      (await scope.transactions.findByIdempotencyKey(command.idempotencyKey)) ??
      (await scope.transactions.findByExternalId(command.providerId, command.externalTransactionId))
    );
  }
}
