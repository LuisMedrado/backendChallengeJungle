import { LedgerDirection, WalletLedgerEntry } from '../ledger/wallet-ledger-entry';
import type { MoneyProps } from '../money/money';
import { InvalidTransactionStateError } from '../shared/errors';
import { FailureCode } from '../wagering/failure-code';
import { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from '../wagering/wager-transaction';
import { Wallet } from '../wallet/wallet';
import { type EventContext, IntegrationEvent, type IntegrationEventProps } from './integration-event';

// aggregateId = walletId em todos os eventos deixa a wallet servindo como aggregate root

function assertStatus(tx: WagerTransaction, expected: WagerTransactionStatus, eventType: string): void {
  if (tx.status !== expected) {
    throw new InvalidTransactionStateError(`${eventType} exige status ${expected}, recebido ${tx.status}`);
  }
}

// campo que o status garante preenchido, vai lançar em vez de usar ! se der ruim
function required<T>(value: T | undefined, field: string, tx: WagerTransaction): T {
  if (value === undefined) {
    throw new InvalidTransactionStateError(`transação ${tx.id} em ${tx.status} sem ${field}`);
  }
  return value;
}

export interface WagerTransactionProcessedData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceTransactionId?: string;
  balanceAfter: MoneyProps;
}

// qualquer transação aplicada, inclusive LOSS
export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  override readonly eventType = 'WagerTransactionProcessed';
  override readonly version = 1;

  private constructor(props: IntegrationEventProps<WagerTransactionProcessedData>) {
    super(props);
  }

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionProcessed {
    assertStatus(tx, WagerTransactionStatus.Processed, 'WagerTransactionProcessed');
    return new WagerTransactionProcessed({
      ...ctx,
      aggregateId: tx.walletId,
      data: {
        transactionId: tx.id,
        providerId: tx.providerId,
        externalTransactionId: tx.externalTransactionId,
        walletId: tx.walletId,
        playerId: tx.playerId,
        roundId: tx.roundId,
        gameId: tx.gameId,
        kind: tx.kind,
        money: tx.money.toJSON(),
        referenceTransactionId: tx.referenceTransactionId,
        balanceAfter: required(tx.balanceAfter, 'balanceAfter', tx).toJSON(),
      },
    });
  }
}

export interface WagerTransactionRejectedData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  failureCode: FailureCode;
}

// transação rejeitada por regra de negócio
export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  override readonly eventType = 'WagerTransactionRejected';
  override readonly version = 1;

  private constructor(props: IntegrationEventProps<WagerTransactionRejectedData>) {
    super(props);
  }

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionRejected {
    assertStatus(tx, WagerTransactionStatus.Rejected, 'WagerTransactionRejected');
    return new WagerTransactionRejected({
      ...ctx,
      aggregateId: tx.walletId,
      data: {
        transactionId: tx.id,
        providerId: tx.providerId,
        externalTransactionId: tx.externalTransactionId,
        walletId: tx.walletId,
        playerId: tx.playerId,
        roundId: tx.roundId,
        kind: tx.kind,
        money: tx.money.toJSON(),
        failureCode: required(tx.failureCode, 'failureCode', tx),
      },
    });
  }
}

export interface WagerTransactionPendingReferenceData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  kind: WagerTransactionKind;
  referenceExternalTransactionId: string;
  attempts: number;
  nextCheckAt: string; // ISO-8601
}

// referência ausente então a transação aguarda reprocessamento pelo worker
export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  override readonly eventType = 'WagerTransactionPendingReference';
  override readonly version = 1;

  private constructor(props: IntegrationEventProps<WagerTransactionPendingReferenceData>) {
    super(props);
  }

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionPendingReference {
    assertStatus(tx, WagerTransactionStatus.PendingReference, 'WagerTransactionPendingReference');
    return new WagerTransactionPendingReference({
      ...ctx,
      aggregateId: tx.walletId,
      data: {
        transactionId: tx.id,
        providerId: tx.providerId,
        externalTransactionId: tx.externalTransactionId,
        walletId: tx.walletId,
        kind: tx.kind,
        referenceExternalTransactionId: required(tx.referenceExternalTransactionId, 'referenceExternalTransactionId', tx),
        attempts: tx.referenceAttempts,
        nextCheckAt: required(tx.nextReferenceCheckAt, 'nextReferenceCheckAt', tx).toISOString(),
      },
    });
  }
}

export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

// somente quando o saldo muda
export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  override readonly eventType = 'WalletBalanceChanged';
  override readonly version = 1;

  private constructor(props: IntegrationEventProps<WalletBalanceChangedData>) {
    super(props);
  }

  static from(wallet: Wallet, entry: WalletLedgerEntry, ctx: EventContext): WalletBalanceChanged {
    return new WalletBalanceChanged({
      ...ctx,
      aggregateId: wallet.id,
      data: {
        walletId: wallet.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        walletVersion: wallet.version,
      },
    });
  }
}
