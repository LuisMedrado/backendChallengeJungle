import type { QueryResult } from '@mikro-orm/core';
import type { EntityManager } from '@mikro-orm/postgresql';
import { ConcurrentModificationError } from '../../application/errors';
import type {
  LedgerPageItem,
  LedgerRepository,
  LedgerSummary,
  OutboxRepository,
  TransactionScope,
  WagerTransactionRepository,
  WalletRepository,
} from '../../application/ports';
import { type LedgerDirection, WalletLedgerEntry } from '../../domain/ledger/wallet-ledger-entry';
import { OutboxMessage } from '../../domain/messaging/outbox-message';
import { Money } from '../../domain/money/money';
import type { FailureCode } from '../../domain/wagering/failure-code';
import {
  WagerTransaction,
  type WagerTransactionKind,
  type WagerTransactionStatus,
} from '../../domain/wagering/wager-transaction';
import { Wallet } from '../../domain/wallet/wallet';

// SQL explícito em cima do EntityManager do MikroORM: o em dá a transação e o pool,
// o SQL deixa o FOR UPDATE e as colunas visíveis. NUMERIC chega como string e vai direto pro Money

// numeric do banco pode vir negativo numa soma, quando a reconciliação pega dado corrompido
function moneyFromNumeric(value: string, currency: string): Money {
  return value.startsWith('-')
    ? Money.from({ amount: value.slice(1), currency }).negate()
    : Money.from({ amount: value, currency });
}

// o driver do MikroORM devolve timestamptz como string, então converte explícito pra Date
type DbTimestamp = Date | string;

function toDate(value: DbTimestamp): Date {
  return value instanceof Date ? value : new Date(value);
}

function optionalDate(value: DbTimestamp | null): Date | undefined {
  return value === null ? undefined : toDate(value);
}

// ---- wallets

interface WalletRow {
  id: string;
  player_id: string;
  currency: string;
  balance: string;
  version: number;
  created_at: DbTimestamp;
  updated_at: DbTimestamp;
}

const WALLET_COLUMNS = 'id, player_id, currency, balance, version, created_at, updated_at';

function toWallet(row: WalletRow): Wallet {
  return Wallet.rehydrate({
    id: row.id,
    playerId: row.player_id,
    currency: row.currency,
    balance: Money.from({ amount: row.balance, currency: row.currency }),
    version: row.version,
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
  });
}

class SqlWalletRepository implements WalletRepository {
  constructor(private readonly em: EntityManager) {}

  async lockById(walletId: string): Promise<Wallet | undefined> {
    const rows = await this.em.execute<WalletRow[]>(`SELECT ${WALLET_COLUMNS} FROM wallets WHERE id = ? FOR UPDATE`, [
      walletId,
    ]);
    return rows[0] ? toWallet(rows[0]) : undefined;
  }

  async findById(walletId: string): Promise<Wallet | undefined> {
    const rows = await this.em.execute<WalletRow[]>(`SELECT ${WALLET_COLUMNS} FROM wallets WHERE id = ?`, [walletId]);
    return rows[0] ? toWallet(rows[0]) : undefined;
  }

  async insert(wallet: Wallet): Promise<void> {
    await this.em.execute(
      `INSERT INTO wallets (${WALLET_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [wallet.id, wallet.playerId, wallet.currency, wallet.balance.amount, wallet.version, wallet.createdAt, wallet.updatedAt],
      'run',
    );
  }

  async saveBalance(wallet: Wallet, expectedVersion: number): Promise<void> {
    // version no WHERE é segunda barreira além do lock: se alguém mexeu no meio, nada é gravado
    const result = await this.em.execute<QueryResult>(
      `UPDATE wallets SET balance = ?, version = ?, updated_at = ? WHERE id = ? AND version = ?`,
      [wallet.balance.amount, wallet.version, wallet.updatedAt, wallet.id, expectedVersion],
      'run',
    );
    if (result.affectedRows !== 1) {
      throw new ConcurrentModificationError(`wallet ${wallet.id} mudou de version durante a operação`);
    }
  }
}

// ---- wager_transactions

interface TransactionRow {
  id: string;
  provider_id: string;
  external_transaction_id: string;
  idempotency_key: string;
  payload_hash: string;
  wallet_id: string;
  player_id: string;
  round_id: string;
  game_id: string;
  kind: WagerTransactionKind;
  amount: string;
  currency: string;
  reference_external_transaction_id: string | null;
  reference_transaction_id: string | null;
  status: WagerTransactionStatus;
  failure_code: FailureCode | null;
  balance_after: string | null;
  reference_attempts: number;
  next_reference_check_at: DbTimestamp | null;
  processed_at: DbTimestamp | null;
  created_at: DbTimestamp;
  wallet_currency: string;
}

// join com wallets pq balance_after tá na moeda da wallet, não da transação
const TRANSACTION_SELECT = `
  SELECT t.id, t.provider_id, t.external_transaction_id, t.idempotency_key, t.payload_hash, t.wallet_id,
         t.player_id, t.round_id, t.game_id, t.kind, t.amount, t.currency, t.reference_external_transaction_id,
         t.reference_transaction_id, t.status, t.failure_code, t.balance_after, t.reference_attempts,
         t.next_reference_check_at, t.processed_at, t.created_at, w.currency AS wallet_currency
    FROM wager_transactions t
    JOIN wallets w ON w.id = t.wallet_id`;

function toTransaction(row: TransactionRow): WagerTransaction {
  return WagerTransaction.rehydrate({
    id: row.id,
    providerId: row.provider_id,
    externalTransactionId: row.external_transaction_id,
    idempotencyKey: row.idempotency_key,
    payloadHash: row.payload_hash,
    walletId: row.wallet_id,
    playerId: row.player_id,
    roundId: row.round_id,
    gameId: row.game_id,
    kind: row.kind,
    money: Money.from({ amount: row.amount, currency: row.currency }),
    referenceExternalTransactionId: row.reference_external_transaction_id ?? undefined,
    referenceTransactionId: row.reference_transaction_id ?? undefined,
    status: row.status,
    failureCode: row.failure_code ?? undefined,
    balanceAfter: row.balance_after === null ? undefined : Money.from({ amount: row.balance_after, currency: row.wallet_currency }),
    referenceAttempts: row.reference_attempts,
    nextReferenceCheckAt: optionalDate(row.next_reference_check_at),
    processedAt: optionalDate(row.processed_at),
    createdAt: toDate(row.created_at),
  });
}

class SqlWagerTransactionRepository implements WagerTransactionRepository {
  constructor(private readonly em: EntityManager) {}

  private async findOne(where: string, params: unknown[]): Promise<WagerTransaction | undefined> {
    const rows = await this.em.execute<TransactionRow[]>(`${TRANSACTION_SELECT} WHERE ${where}`, params);
    return rows[0] ? toTransaction(rows[0]) : undefined;
  }

  findById(transactionId: string): Promise<WagerTransaction | undefined> {
    return this.findOne('t.id = ?', [transactionId]);
  }

  findByIdempotencyKey(idempotencyKey: string): Promise<WagerTransaction | undefined> {
    return this.findOne('t.idempotency_key = ?', [idempotencyKey]);
  }

  findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined> {
    return this.findOne('t.provider_id = ? AND t.external_transaction_id = ?', [providerId, externalTransactionId]);
  }

  async hasProcessedReversal(referenceTransactionId: string, kind: WagerTransactionKind): Promise<boolean> {
    const rows = await this.em.execute<{ found: boolean }[]>(
      `SELECT EXISTS (
         SELECT 1 FROM wager_transactions
          WHERE reference_transaction_id = ? AND kind = ? AND status = 'PROCESSED'
       ) AS found`,
      [referenceTransactionId, kind],
    );
    return rows[0]?.found === true;
  }

  async insert(tx: WagerTransaction): Promise<void> {
    await this.em.execute(
      `INSERT INTO wager_transactions (
         id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id, round_id,
         game_id, kind, amount, currency, reference_external_transaction_id, reference_transaction_id, status,
         failure_code, balance_after, reference_attempts, next_reference_check_at, processed_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        tx.id,
        tx.providerId,
        tx.externalTransactionId,
        tx.idempotencyKey,
        tx.payloadHash,
        tx.walletId,
        tx.playerId,
        tx.roundId,
        tx.gameId,
        tx.kind,
        tx.money.amount,
        tx.money.currency,
        tx.referenceExternalTransactionId ?? null,
        tx.referenceTransactionId ?? null,
        tx.status,
        tx.failureCode ?? null,
        tx.balanceAfter?.amount ?? null,
        tx.referenceAttempts,
        tx.nextReferenceCheckAt ?? null,
        tx.processedAt ?? null,
        tx.createdAt,
        tx.processedAt ?? tx.createdAt,
      ],
      'run',
    );
  }
}

// ---- wallet_ledger_entries

interface LedgerRow {
  id: string;
  sequence: string;
  wallet_id: string;
  transaction_id: string;
  direction: LedgerDirection;
  amount: string;
  balance_before: string;
  balance_after: string;
  currency: string;
  created_at: DbTimestamp;
}

class SqlLedgerRepository implements LedgerRepository {
  constructor(private readonly em: EntityManager) {}

  async insert(entry: WalletLedgerEntry): Promise<void> {
    await this.em.execute(
      `INSERT INTO wallet_ledger_entries
         (id, wallet_id, transaction_id, direction, amount, balance_before, balance_after, currency, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        entry.id,
        entry.walletId,
        entry.transactionId,
        entry.direction,
        entry.money.amount,
        entry.balanceBefore.amount,
        entry.balanceAfter.amount,
        entry.money.currency,
        entry.createdAt,
      ],
      'run',
    );
  }

  async page(walletId: string, afterSequence: bigint | undefined, limit: number): Promise<LedgerPageItem[]> {
    // sequence começa em 1, então "depois do 0" é do começo
    const rows = await this.em.execute<LedgerRow[]>(
      `SELECT id, sequence, wallet_id, transaction_id, direction, amount, balance_before, balance_after, currency, created_at
         FROM wallet_ledger_entries
        WHERE wallet_id = ? AND sequence > ?
        ORDER BY sequence
        LIMIT ?`,
      [walletId, (afterSequence ?? 0n).toString(), limit],
    );
    return rows.map((row) => ({
      sequence: BigInt(row.sequence),
      entry: WalletLedgerEntry.rehydrate({
        id: row.id,
        walletId: row.wallet_id,
        transactionId: row.transaction_id,
        direction: row.direction,
        money: Money.from({ amount: row.amount, currency: row.currency }),
        balanceBefore: Money.from({ amount: row.balance_before, currency: row.currency }),
        balanceAfter: Money.from({ amount: row.balance_after, currency: row.currency }),
        createdAt: toDate(row.created_at),
      }),
    }));
  }

  async summarize(walletId: string, currency: string): Promise<LedgerSummary> {
    // cast pra numeric 19,2 garante 2 casas até quando não tem lançamento nenhum, o 0 vira 0.00
    const rows = await this.em.execute<{ balance: string; entries: number }[]>(
      `SELECT COALESCE(SUM(CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END), 0)::numeric(19,2) AS balance,
              count(*)::int AS entries
         FROM wallet_ledger_entries
        WHERE wallet_id = ?`,
      [walletId],
    );
    const row = rows[0] ?? { balance: '0.00', entries: 0 };
    return { balance: moneyFromNumeric(row.balance, currency), entries: row.entries };
  }
}

// ---- outbox_messages

class SqlOutboxRepository implements OutboxRepository {
  constructor(private readonly em: EntityManager) {}

  async add(messages: OutboxMessage[]): Promise<void> {
    for (const message of messages) {
      await this.em.execute(
        `INSERT INTO outbox_messages (id, aggregate_id, event_type, payload, occurred_at, attempts)
         VALUES (?, ?, ?, ?::jsonb, ?, ?)`,
        [
          message.id,
          message.aggregateId,
          message.eventType,
          JSON.stringify(message.payload),
          message.occurredAt,
          message.attempts,
        ],
        'run',
      );
    }
  }

  async claimDue(now: Date, limit: number): Promise<OutboxMessage[]> {
    // SKIP LOCKED faz cada publisher pegar linhas diferentes sem esperar o outro
    const rows = await this.em.execute<OutboxRow[]>(
      `SELECT id, aggregate_id, event_type, payload, occurred_at, attempts, next_attempt_at, published_at
         FROM outbox_messages
        WHERE published_at IS NULL
          AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
        ORDER BY sequence
        LIMIT ?
        FOR UPDATE SKIP LOCKED`,
      [now, limit],
    );
    return rows.map(toOutboxMessage);
  }

  async save(message: OutboxMessage): Promise<void> {
    await this.em.execute(
      `UPDATE outbox_messages SET attempts = ?, next_attempt_at = ?, published_at = ? WHERE id = ?`,
      [message.attempts, message.nextAttemptAt ?? null, message.publishedAt ?? null, message.id],
      'run',
    );
  }
}

interface OutboxRow {
  id: string;
  aggregate_id: string;
  event_type: string;
  payload: Record<string, unknown> | string;
  occurred_at: DbTimestamp;
  attempts: number;
  next_attempt_at: DbTimestamp | null;
  published_at: DbTimestamp | null;
}

function toOutboxMessage(row: OutboxRow): OutboxMessage {
  return OutboxMessage.rehydrate({
    id: row.id,
    aggregateId: row.aggregate_id,
    eventType: row.event_type,
    // jsonb pode chegar já parseado ou como texto dependendo do driver
    payload: typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload,
    occurredAt: toDate(row.occurred_at),
    attempts: row.attempts,
    nextAttemptAt: optionalDate(row.next_attempt_at),
    publishedAt: optionalDate(row.published_at),
  });
}

export function createScope(em: EntityManager): TransactionScope {
  return {
    wallets: new SqlWalletRepository(em),
    transactions: new SqlWagerTransactionRepository(em),
    ledger: new SqlLedgerRepository(em),
    outbox: new SqlOutboxRepository(em),
  };
}
