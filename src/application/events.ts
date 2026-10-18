import type { EventContext } from '../domain/events/integration-event';
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from '../domain/events/wagering-events';
import type { WalletLedgerEntry } from '../domain/ledger/wallet-ledger-entry';
import { OutboxMessage } from '../domain/messaging/outbox-message';
import { type WagerTransaction, WagerTransactionStatus } from '../domain/wagering/wager-transaction';
import type { Wallet } from '../domain/wallet/wallet';
import type { Clock, IdGenerator } from './ports';

export interface EventTrace {
  correlationId: string;
  causationId?: string;
}

// monta os eventos da outbox a partir do estado final da transação
export function outboxMessagesFor(
  transaction: WagerTransaction,
  wallet: Wallet,
  ledgerEntry: WalletLedgerEntry | undefined,
  trace: EventTrace,
  ids: IdGenerator,
  clock: Clock,
): OutboxMessage[] {
  const context = (): EventContext => ({ eventId: ids.next(), occurredAt: clock.now(), ...trace });

  const events = [];
  switch (transaction.status) {
    case WagerTransactionStatus.Processed:
      events.push(WagerTransactionProcessed.from(transaction, context()));
      // só quando o saldo muda
      if (ledgerEntry) events.push(WalletBalanceChanged.from(wallet, ledgerEntry, context()));
      break;
    case WagerTransactionStatus.Rejected:
      events.push(WagerTransactionRejected.from(transaction, context()));
      break;
    case WagerTransactionStatus.PendingReference:
      events.push(WagerTransactionPendingReference.from(transaction, context()));
      break;
    default:
      break;
  }
  return events.map((event) => OutboxMessage.enqueue(event));
}
