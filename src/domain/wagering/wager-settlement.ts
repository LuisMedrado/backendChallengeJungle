import { LedgerDirection, WalletLedgerEntry } from '../ledger/wallet-ledger-entry';
import { InvalidTransactionStateError, InvalidWagerTransactionError } from '../shared/errors';
import { Wallet } from '../wallet/wallet';
import { FailureCode } from './failure-code';
import { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from './wager-transaction';

export interface SettleWagerInput {
  transaction: WagerTransaction;
  /** wallet já travada pelo use case */
  wallet: Wallet;
  /** resolvida por providerId e referenceExternalTransactionId, undefined se ainda não chegou */
  reference?: WagerTransaction;
  /** checa se já existe reversão PROCESSED do mesmo tipo para a referência, mas também tá garantido por índice único */
  referenceAlreadyReversed?: boolean;
  ledgerEntryId: string;
  now: Date;
}

export type SettlementResult =
  | { status: WagerTransactionStatus.Processed; ledgerEntry: WalletLedgerEntry | undefined }
  | { status: WagerTransactionStatus.Rejected; failureCode: FailureCode }
  | { status: WagerTransactionStatus.PendingReference };

/**
 * serviço de domínio que aplica as regras de BET/WIN/LOSS/REFUND/ROLLBACK
 * puro, não acessa banco e muta a transação e a wallet
 */
export class WagerSettlement {
  private constructor() {}

  static settle(input: SettleWagerInput): SettlementResult {
    const { transaction: tx, wallet, reference, now } = input;

    const rejectWith = (failureCode: FailureCode): SettlementResult => {
      tx.reject(failureCode, wallet.balance);
      return { status: WagerTransactionStatus.Rejected, failureCode };
    };

    // guard antes de qualquer mutação pq sem ele, reaplicar uma transação decidida debitaria
    // a wallet e só depois falharia, na etapa de transição de estado
    if (tx.isTerminal()) {
      throw new InvalidTransactionStateError(`transação ${tx.id} já está ${tx.status}`);
    }
    if (tx.walletId !== wallet.id) {
      // o use case carrega a wallet pelo walletId da transação, se tiver divergente bugou
      throw new InvalidWagerTransactionError(`wallet ${wallet.id} não corresponde à transação ${tx.id}`);
    }
    if (tx.playerId !== wallet.playerId) return rejectWith(FailureCode.WalletPlayerMismatch);
    if (tx.money.currency !== wallet.currency) return rejectWith(FailureCode.CurrencyMismatch);

    if (tx.referenceExternalTransactionId) {
      // referência ausente ou ainda não decidida o comportamento eh aguardar 
      if (!reference || !reference.isTerminal()) {
        tx.markPendingReference(now);
        return { status: WagerTransactionStatus.PendingReference };
      }
      const referenceFailure = WagerSettlement.validateReference(
        tx,
        reference,
        input.referenceAlreadyReversed ?? false,
      );
      if (referenceFailure) return rejectWith(referenceFailure);
    }

    if (!tx.affectsBalance()) {
      tx.markProcessed(reference?.id, now, wallet.balance);
      return { status: WagerTransactionStatus.Processed, ledgerEntry: undefined };
    }

    const direction = tx.ledgerDirectionFor(reference);
    if (direction === LedgerDirection.Debit && !wallet.canDebit(tx.money)) {
      // aposta sem saldo e reversão que estouraria o saldo são situações distintas
      return rejectWith(
        tx.kind === WagerTransactionKind.Bet ? FailureCode.InsufficientFunds : FailureCode.ReversalWouldOverdraw,
      );
    }

    const movement = { ledgerEntryId: input.ledgerEntryId, transactionId: tx.id, money: tx.money, at: now };
    const ledgerEntry =
      direction === LedgerDirection.Debit ? wallet.debit(movement) : wallet.credit(movement);
    tx.markProcessed(reference?.id, now, wallet.balance);
    return { status: WagerTransactionStatus.Processed, ledgerEntry };
  }

  private static validateReference(
    tx: WagerTransaction,
    reference: WagerTransaction,
    alreadyReversed: boolean,
  ): FailureCode | undefined {
    const sameContext =
      reference.providerId === tx.providerId &&
      reference.playerId === tx.playerId &&
      reference.walletId === tx.walletId &&
      reference.roundId === tx.roundId &&
      reference.money.currency === tx.money.currency;
    if (!sameContext) return FailureCode.ReferenceMismatch;
    if (!tx.canReference(reference)) return FailureCode.ReferenceKindNotAllowed;
    if (reference.status !== WagerTransactionStatus.Processed) return FailureCode.ReferenceNotProcessed;

    if (tx.isReversal()) {
      if (!reference.money.equals(tx.money)) return FailureCode.ReferenceAmountMismatch;
      if (alreadyReversed) return FailureCode.ReferenceAlreadyReversed;
    }
    return undefined;
  }
}
