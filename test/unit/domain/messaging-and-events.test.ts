import { describe, expect, it } from 'bun:test';
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from '../../../src/domain/events/wagering-events';
import { LedgerDirection } from '../../../src/domain/ledger/wallet-ledger-entry';
import { InboxMessage } from '../../../src/domain/messaging/inbox-message';
import { OutboxMessage } from '../../../src/domain/messaging/outbox-message';
import { InvalidStateTransitionError, InvalidTransactionStateError } from '../../../src/domain/shared/errors';
import { FailureCode } from '../../../src/domain/wagering/failure-code';
import { WagerTransactionKind as Kind } from '../../../src/domain/wagering/wager-transaction';
import { NOW, brl, openWallet, wagerTx } from './fixtures';

const ctx = { eventId: 'evt-1', correlationId: 'corr-1', causationId: 'msg-1', occurredAt: NOW };

describe('eventos de integração', () => {
  it('WalletBalanceChanged serializa envelope com MoneyProps, tipo e versão da classe', () => {
    const { wallet } = openWallet('100.00');
    const entry = wallet.debit({ ledgerEntryId: 'e', transactionId: 'tx-1', money: brl('25.00'), at: NOW });
    const json = WalletBalanceChanged.from(wallet, entry, ctx).toJSON();

    expect(json).toEqual({
      eventId: 'evt-1',
      eventType: 'WalletBalanceChanged',
      aggregateId: wallet.id,
      correlationId: 'corr-1',
      causationId: 'msg-1',
      occurredAt: NOW.toISOString(),
      version: 1,
      data: {
        walletId: wallet.id,
        transactionId: 'tx-1',
        direction: LedgerDirection.Debit,
        money: { amount: '25.00', currency: 'BRL' },
        balanceBefore: { amount: '100.00', currency: 'BRL' },
        balanceAfter: { amount: '75.00', currency: 'BRL' },
        walletVersion: 2,
      },
    });
  });

  it('cada evento exige o status correspondente da transação', () => {
    const pending = wagerTx();
    expect(() => WagerTransactionProcessed.from(pending, ctx)).toThrow(InvalidTransactionStateError);
    expect(() => WagerTransactionRejected.from(pending, ctx)).toThrow(InvalidTransactionStateError);
    expect(() => WagerTransactionPendingReference.from(pending, ctx)).toThrow(InvalidTransactionStateError);
  });

  it('WagerTransactionRejected carrega o failureCode', () => {
    const tx = wagerTx();
    tx.reject(FailureCode.InsufficientFunds, brl('1.00'));
    expect(WagerTransactionRejected.from(tx, ctx).data.failureCode).toBe(FailureCode.InsufficientFunds);
  });

  it('WagerTransactionPendingReference carrega tentativas e prox check', () => {
    const tx = wagerTx({ kind: Kind.Refund, referenceExternalTransactionId: 'bet-1' });
    tx.markPendingReference(NOW);
    const data = WagerTransactionPendingReference.from(tx, ctx).data;
    expect(data.attempts).toBe(1);
    expect(data.referenceExternalTransactionId).toBe('bet-1');
  });
});

describe('OutboxMessage', () => {
  const processedEvent = () => {
    const tx = wagerTx();
    tx.markProcessed(undefined, NOW, brl('90.00'));
    return WagerTransactionProcessed.from(tx, ctx);
  };

  it('enqueue usa eventId como id e grava payload', () => {
    const message = OutboxMessage.enqueue(processedEvent());
    expect(message.id).toBe('evt-1');
    expect(message.eventType).toBe('WagerTransactionProcessed');
    expect(message.payload.occurredAt).toBe(NOW.toISOString());
    expect(message.isDue(NOW)).toBe(true);
  });

  it('scheduleRetry aplica backoff e isDue respeita nextAttemptAt', () => {
    const message = OutboxMessage.enqueue(processedEvent());
    message.scheduleRetry(NOW);
    expect(message.attempts).toBe(1);
    expect(message.isDue(NOW)).toBe(false);
    expect(message.isDue(new Date(NOW.getTime() + 1_000))).toBe(true);

    message.scheduleRetry(NOW);
    expect(message.nextAttemptAt!.getTime() - NOW.getTime()).toBe(2_000);
  });

  it('publicado deixa de estar pendente e não pode ser republicado pelo domínio', () => {
    const message = OutboxMessage.enqueue(processedEvent());
    message.markPublished(NOW);
    expect(message.isPending()).toBe(false);
    expect(message.isDue(NOW)).toBe(false);
    expect(() => message.markPublished(NOW)).toThrow(InvalidStateTransitionError);
    expect(() => message.scheduleRetry(NOW)).toThrow(InvalidStateTransitionError);
  });
});

describe('InboxMessage', () => {
  it('marca como processada uma única vez', () => {
    const inbox = InboxMessage.receive({
      messageId: 'msg-1',
      consumerName: 'wager-consumer',
      payloadHash: 'h',
      receivedAt: NOW,
    });
    expect(inbox.isProcessed()).toBe(false);
    inbox.markProcessed(NOW);
    expect(inbox.isProcessed()).toBe(true);
    expect(() => inbox.markProcessed(NOW)).toThrow(InvalidStateTransitionError);
  });
});
