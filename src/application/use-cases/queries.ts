import type { Money } from '../../domain/money/money';
import type { WagerTransaction } from '../../domain/wagering/wager-transaction';
import type { Wallet } from '../../domain/wallet/wallet';
import { InvalidRequestError, WagerTransactionNotFoundError, WalletNotFoundError } from '../errors';
import type { LedgerPageItem, UnitOfWork } from '../ports';

export const LEDGER_DEFAULT_LIMIT = 50;
export const LEDGER_MAX_LIMIT = 200;

export class GetWallet {
  constructor(private readonly uow: UnitOfWork) {}

  execute(walletId: string): Promise<Wallet> {
    return this.uow.read(async (scope) => {
      const wallet = await scope.wallets.findById(walletId);
      if (!wallet) throw new WalletNotFoundError(walletId);
      return wallet;
    });
  }
}

export interface LedgerPage {
  items: LedgerPageItem[];
  nextCursor: string | null;
}

// cursor opaco pro cliente, por dentro é só a sequence do último item em base64url
export function encodeLedgerCursor(sequence: bigint): string {
  return Buffer.from(`s:${sequence}`).toString('base64url');
}

export function decodeLedgerCursor(cursor: string): bigint {
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  const match = /^s:(\d{1,19})$/.exec(decoded);
  if (!match?.[1]) throw new InvalidRequestError('cursor inválido');
  return BigInt(match[1]);
}

export class GetWalletLedger {
  constructor(private readonly uow: UnitOfWork) {}

  execute(walletId: string, cursor: string | undefined, limit = LEDGER_DEFAULT_LIMIT): Promise<LedgerPage> {
    const afterSequence = cursor === undefined ? undefined : decodeLedgerCursor(cursor);

    return this.uow.read(async (scope) => {
      const wallet = await scope.wallets.findById(walletId);
      if (!wallet) throw new WalletNotFoundError(walletId);

      // busca um a mais só pra saber se tem próxima página
      const rows = await scope.ledger.page(walletId, afterSequence, limit + 1);
      const items = rows.slice(0, limit);
      const last = items.at(-1);
      return { items, nextCursor: rows.length > limit && last ? encodeLedgerCursor(last.sequence) : null };
    });
  }
}

export class GetWagerTransaction {
  constructor(private readonly uow: UnitOfWork) {}

  byId(transactionId: string): Promise<WagerTransaction> {
    return this.uow.read(async (scope) => {
      const transaction = await scope.transactions.findById(transactionId);
      if (!transaction) throw new WagerTransactionNotFoundError(transactionId);
      return transaction;
    });
  }

  byExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction> {
    return this.uow.read(async (scope) => {
      const transaction = await scope.transactions.findByExternalId(providerId, externalTransactionId);
      if (!transaction) throw new WagerTransactionNotFoundError(`${providerId}/${externalTransactionId}`);
      return transaction;
    });
  }
}

export interface ReconciliationReport {
  walletId: string;
  storedBalance: Money;
  calculatedBalance: Money;
  difference: Money;
  consistent: boolean;
  checkedEntries: number;
}

export interface ReconciliationListener {
  onDivergence(report: ReconciliationReport): void;
}

// compara o saldo gravado na wallet com o saldo reconstruído pelo ledger
// divergência não é corrigida, só avisada pro listener que loga e conta na métrica, e devolvida na resposta
export class ReconcileWallet {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly listener: ReconciliationListener,
  ) {}

  async execute(walletId: string): Promise<ReconciliationReport> {
    const report = await this.uow.read(async (scope) => {
      const wallet = await scope.wallets.findById(walletId);
      if (!wallet) throw new WalletNotFoundError(walletId);

      const summary = await scope.ledger.summarize(walletId, wallet.currency);
      const difference = wallet.balance.subtract(summary.balance);
      return {
        walletId,
        storedBalance: wallet.balance,
        calculatedBalance: summary.balance,
        difference,
        consistent: difference.isZero(),
        checkedEntries: summary.entries,
      };
    });

    if (!report.consistent) this.listener.onDivergence(report);
    return report;
  }
}
