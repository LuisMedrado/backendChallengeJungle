import { WalletLedgerEntry, LedgerDirection } from '../../../src/domain/ledger/wallet-ledger-entry';
import { Money } from '../../../src/domain/money/money';
import {
  type CreateWagerTransactionProps,
  WagerTransaction,
  WagerTransactionKind,
} from '../../../src/domain/wagering/wager-transaction';
import { Wallet } from '../../../src/domain/wallet/wallet';

export const NOW = new Date('2026-10-17T12:00:00.000Z');

export const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' });
export const usd = (amount: string): Money => Money.from({ amount, currency: 'USD' });

let sequence = 0;
export const nextId = (prefix: string): string => `${prefix}-${++sequence}`;

export const WALLET_ID = 'wallet-1';
export const PLAYER_ID = 'player-1';

export function openWallet(initialBalance = '100.00'): { wallet: Wallet; entries: WalletLedgerEntry[] } {
  const { wallet, openingEntry } = Wallet.open({
    id: WALLET_ID,
    playerId: PLAYER_ID,
    initialBalance: brl(initialBalance),
    openingTransactionId: nextId('tx-opening'),
    openingLedgerEntryId: nextId('entry'),
    at: NOW,
  });
  return { wallet, entries: openingEntry ? [openingEntry] : [] };
}

export function wagerTx(overrides: Partial<CreateWagerTransactionProps> = {}): WagerTransaction {
  const externalTransactionId = overrides.externalTransactionId ?? nextId('ext');
  return WagerTransaction.create({
    id: nextId('tx'),
    providerId: 'provider-a',
    externalTransactionId,
    idempotencyKey: `provider-a:${externalTransactionId}`,
    payloadHash: 'hash',
    walletId: WALLET_ID,
    playerId: PLAYER_ID,
    roundId: 'round-1',
    gameId: 'tigrao',
    kind: WagerTransactionKind.Bet,
    money: brl('10.00'),
    createdAt: NOW,
    ...overrides,
  });
}

/** saldo reconstruído a partir do ledger */
export function balanceFromLedger(entries: WalletLedgerEntry[], currency = 'BRL'): Money {
  return entries.reduce(
    (total, entry) =>
      entry.direction === LedgerDirection.Credit ? total.add(entry.money) : total.subtract(entry.money),
    Money.zero(currency),
  );
}
