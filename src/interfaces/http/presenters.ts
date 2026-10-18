import type { LedgerPageItem } from '../../application/ports';
import type { ProcessWagerResult } from '../../application/use-cases/process-wager-transaction';
import type { ReconciliationReport } from '../../application/use-cases/queries';
import type { MoneyProps } from '../../domain/money/money';
import { type WagerTransaction, WagerTransactionStatus } from '../../domain/wagering/wager-transaction';
import type { Wallet } from '../../domain/wallet/wallet';

// formato de saída da api, dinheiro sempre como MoneyProps com string de 2 casas

export function presentWallet(wallet: Wallet) {
  return {
    id: wallet.id,
    playerId: wallet.playerId,
    balance: wallet.balance.toJSON(),
    version: wallet.version,
  };
}

export function presentLedgerItem({ entry }: LedgerPageItem) {
  return {
    id: entry.id,
    transactionId: entry.transactionId,
    direction: entry.direction,
    money: entry.money.toJSON(),
    balanceBefore: entry.balanceBefore.toJSON(),
    balanceAfter: entry.balanceAfter.toJSON(),
    createdAt: entry.createdAt.toISOString(),
  };
}

export interface SubmitWagerResponse {
  transactionId: string;
  status: WagerTransactionStatus;
  failureCode?: string;
  balance: MoneyProps | null;
  idempotentReplay: boolean;
}

export function presentSubmitResult({ transaction, idempotentReplay }: ProcessWagerResult): SubmitWagerResponse {
  return {
    transactionId: transaction.id,
    status: transaction.status,
    ...(transaction.failureCode ? { failureCode: transaction.failureCode } : {}),
    balance: transaction.balanceAfter?.toJSON() ?? null,
    idempotentReplay,
  };
}

// cada status tem seu código, provedor decide se reenvia sem ler mensagem
export function httpStatusFor(transaction: WagerTransaction): number {
  switch (transaction.status) {
    case WagerTransactionStatus.Processed:
      return 200;
    case WagerTransactionStatus.Rejected:
      return 422;
    case WagerTransactionStatus.Pending:
    case WagerTransactionStatus.PendingReference:
      return 202;
    case WagerTransactionStatus.Failed:
      return 500;
  }
}

export function presentTransaction(transaction: WagerTransaction) {
  return {
    transactionId: transaction.id,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    walletId: transaction.walletId,
    playerId: transaction.playerId,
    roundId: transaction.roundId,
    gameId: transaction.gameId,
    kind: transaction.kind,
    money: transaction.money.toJSON(),
    referenceExternalTransactionId: transaction.referenceExternalTransactionId ?? null,
    referenceTransactionId: transaction.referenceTransactionId ?? null,
    status: transaction.status,
    failureCode: transaction.failureCode ?? null,
    balance: transaction.balanceAfter?.toJSON() ?? null,
    createdAt: transaction.createdAt.toISOString(),
    processedAt: transaction.processedAt?.toISOString() ?? null,
  };
}

export function presentReconciliation(report: ReconciliationReport) {
  return {
    walletId: report.walletId,
    storedBalance: report.storedBalance.toJSON(),
    calculatedBalance: report.calculatedBalance.toJSON(),
    difference: report.difference.toJSON(),
    consistent: report.consistent,
    checkedEntries: report.checkedEntries,
  };
}
