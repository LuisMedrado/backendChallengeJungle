import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Client } from 'pg';
import { connect, insert, migrate } from './support/database';

// códigos de erro do postgres
const UNIQUE_VIOLATION = '23505';
const CHECK_VIOLATION = '23514';
const FOREIGN_KEY_VIOLATION = '23503';
const RESTRICT_VIOLATION = '23001';

const NOW = new Date('2026-10-17T12:00:00.000Z');
const uuid = (): string => crypto.randomUUID();

let db: Client;
let sequence = 0;

beforeAll(async () => {
  await migrate('down');
  await migrate('up');
  db = await connect();
});

afterAll(async () => {
  await db?.end();
});

// ---- fábricas de linha, cada teste sobrescreve só o que importa

const walletRow = (o: Record<string, unknown> = {}) => ({
  id: uuid(),
  player_id: uuid(),
  currency: 'BRL',
  balance: '100.00',
  version: 1,
  created_at: NOW,
  updated_at: NOW,
  ...o,
});

const txRow = (walletId: string, o: Record<string, unknown> = {}) => {
  const external = `ext-${++sequence}`;
  return {
    id: uuid(),
    provider_id: 'provider-a',
    external_transaction_id: external,
    idempotency_key: `provider-a:${external}`,
    payload_hash: 'hash',
    wallet_id: walletId,
    player_id: uuid(),
    round_id: 'round-1',
    game_id: 'tigrao',
    kind: 'BET',
    amount: '10.00',
    currency: 'BRL',
    status: 'PENDING',
    reference_attempts: 0,
    created_at: NOW,
    updated_at: NOW,
    ...o,
  };
};

const processed = { status: 'PROCESSED', processed_at: NOW, balance_after: '90.00' };

const ledgerRow = (walletId: string, transactionId: string, o: Record<string, unknown> = {}) => ({
  id: uuid(),
  wallet_id: walletId,
  transaction_id: transactionId,
  direction: 'DEBIT',
  amount: '10.00',
  balance_before: '100.00',
  balance_after: '90.00',
  currency: 'BRL',
  created_at: NOW,
  ...o,
});

async function newWallet(o: Record<string, unknown> = {}) {
  const row = walletRow(o);
  await insert(db, 'wallets', row);
  return row;
}

async function newTx(walletId: string, o: Record<string, unknown> = {}) {
  const row = txRow(walletId, o);
  await insert(db, 'wager_transactions', row);
  return row;
}

async function tableNames(): Promise<string[]> {
  const { rows } = await db.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name <> 'mikro_orm_migrations' ORDER BY table_name`,
  );
  return rows.map((r) => r.table_name);
}

const EXPECTED_TABLES = ['inbox_messages', 'outbox_messages', 'wager_transactions', 'wallet_ledger_entries', 'wallets'];

describe('migrations', () => {
  it('up cria as tabelas, down remove tudo e up de novo funciona', async () => {
    expect(await tableNames()).toEqual(EXPECTED_TABLES);

    await migrate('down');
    expect(await tableNames()).toEqual([]);

    await migrate('up');
    expect(await tableNames()).toEqual(EXPECTED_TABLES);
  });
});

describe('wallets', () => {
  it('no máximo uma wallet por player + moeda', async () => {
    const wallet = await newWallet();
    await expect(insert(db, 'wallets', walletRow({ player_id: wallet.player_id }))).rejects.toMatchObject({
      code: UNIQUE_VIOLATION,
      constraint: 'wallets_player_currency_uk',
    });
    // msm player em outra moeda pode
    await newWallet({ player_id: wallet.player_id, currency: 'USD' });
  });

  it('saldo nunca negativo', async () => {
    await expect(insert(db, 'wallets', walletRow({ balance: '-0.01' }))).rejects.toMatchObject({
      code: CHECK_VIOLATION,
      constraint: 'wallets_balance_non_negative_ck',
    });
  });

  it('moeda tem que ser ISO-4217', async () => {
    await expect(insert(db, 'wallets', walletRow({ currency: 'brl' }))).rejects.toMatchObject({ code: CHECK_VIOLATION });
  });

  it('version começa em 1', async () => {
    await expect(insert(db, 'wallets', walletRow({ version: 0 }))).rejects.toMatchObject({ code: CHECK_VIOLATION });
  });
});

describe('wager_transactions', () => {
  it('idempotency_key é única', async () => {
    const wallet = await newWallet();
    const tx = await newTx(wallet.id);
    await expect(newTx(wallet.id, { idempotency_key: tx.idempotency_key })).rejects.toMatchObject({
      code: UNIQUE_VIOLATION,
      constraint: 'wager_tx_idempotency_key_uk',
    });
  });

  it('provider + externalTransactionId é único', async () => {
    const wallet = await newWallet();
    const tx = await newTx(wallet.id);
    await expect(
      newTx(wallet.id, { external_transaction_id: tx.external_transaction_id, idempotency_key: 'outra-key' }),
    ).rejects.toMatchObject({ code: UNIQUE_VIOLATION, constraint: 'wager_tx_provider_external_uk' });
  });

  it('kind e status só aceitam os valores do domínio', async () => {
    const wallet = await newWallet();
    await expect(newTx(wallet.id, { kind: 'JACKPOT' })).rejects.toMatchObject({ code: CHECK_VIOLATION });
    await expect(newTx(wallet.id, { status: 'DONE' })).rejects.toMatchObject({ code: CHECK_VIOLATION });
  });

  it('REFUND e ROLLBACK exigem referência', async () => {
    const wallet = await newWallet();
    await expect(newTx(wallet.id, { kind: 'REFUND' })).rejects.toMatchObject({
      code: CHECK_VIOLATION,
      constraint: 'wager_tx_reference_required_ck',
    });
  });

  it('BET não aceita referência', async () => {
    const wallet = await newWallet();
    await expect(newTx(wallet.id, { reference_external_transaction_id: 'ext-x' })).rejects.toMatchObject({
      code: CHECK_VIOLATION,
      constraint: 'wager_tx_reference_allowed_ck',
    });
  });

  it('valor zero só em LOSS', async () => {
    const wallet = await newWallet();
    await expect(newTx(wallet.id, { amount: '0.00' })).rejects.toMatchObject({
      code: CHECK_VIOLATION,
      constraint: 'wager_tx_amount_positive_ck',
    });
    await newTx(wallet.id, { kind: 'LOSS', amount: '0.00' });
  });

  it('REJECTED e FAILED exigem failure_code, os outros status não podem ter', async () => {
    const wallet = await newWallet();
    await expect(newTx(wallet.id, { status: 'REJECTED' })).rejects.toMatchObject({
      code: CHECK_VIOLATION,
      constraint: 'wager_tx_failure_code_ck',
    });
    await expect(newTx(wallet.id, { failure_code: 'INSUFFICIENT_FUNDS' })).rejects.toMatchObject({
      code: CHECK_VIOLATION,
      constraint: 'wager_tx_failure_code_ck',
    });
    await newTx(wallet.id, { status: 'REJECTED', failure_code: 'INSUFFICIENT_FUNDS' });
  });

  it('PROCESSED exige processed_at e balance_after', async () => {
    const wallet = await newWallet();
    await expect(newTx(wallet.id, { status: 'PROCESSED' })).rejects.toMatchObject({ code: CHECK_VIOLATION });
    await newTx(wallet.id, processed);
  });

  it('PENDING_REFERENCE exige next_reference_check_at', async () => {
    const wallet = await newWallet();
    await expect(
      newTx(wallet.id, { kind: 'REFUND', reference_external_transaction_id: 'ext-x', status: 'PENDING_REFERENCE' }),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION, constraint: 'wager_tx_pending_reference_ck' });
  });

  it('wallet precisa existir', async () => {
    await expect(newTx(uuid())).rejects.toMatchObject({ code: FOREIGN_KEY_VIOLATION });
  });

  it('referência tem que ser da msm wallet', async () => {
    const walletA = await newWallet();
    const walletB = await newWallet();
    const betOnA = await newTx(walletA.id, processed);
    await expect(
      newTx(walletB.id, {
        kind: 'REFUND',
        reference_external_transaction_id: betOnA.external_transaction_id,
        reference_transaction_id: betOnA.id,
      }),
    ).rejects.toMatchObject({ code: FOREIGN_KEY_VIOLATION, constraint: 'wager_tx_reference_same_wallet_fk' });
  });

  it('uma referência aceita no máximo uma reversão PROCESSED por tipo', async () => {
    const wallet = await newWallet();
    const bet = await newTx(wallet.id, processed);
    const reversal = (kind: string, status: Record<string, unknown>) =>
      newTx(wallet.id, {
        kind,
        reference_external_transaction_id: bet.external_transaction_id,
        reference_transaction_id: bet.id,
        ...status,
      });

    await reversal('REFUND', processed);
    await expect(reversal('REFUND', processed)).rejects.toMatchObject({
      code: UNIQUE_VIOLATION,
      constraint: 'wager_tx_one_reversal_per_kind_uk',
    });
    // rejeitada não conta, e ROLLBACK eh outro tipo
    await reversal('REFUND', { status: 'REJECTED', failure_code: 'REFERENCE_ALREADY_REVERSED' });
    await reversal('ROLLBACK', processed);
  });

  it('no máximo um OPENING por wallet', async () => {
    const wallet = await newWallet();
    await newTx(wallet.id, { kind: 'OPENING', ...processed });
    await expect(newTx(wallet.id, { kind: 'OPENING', ...processed })).rejects.toMatchObject({
      code: UNIQUE_VIOLATION,
      constraint: 'wager_tx_one_opening_per_wallet_uk',
    });
  });

  it('status terminal não muda', async () => {
    const wallet = await newWallet();
    const tx = await newTx(wallet.id, processed);
    await expect(
      db.query(`UPDATE wager_transactions SET status = 'REJECTED', failure_code = 'INSUFFICIENT_FUNDS', processed_at = NULL WHERE id = $1`, [tx.id]),
    ).rejects.toMatchObject({ code: RESTRICT_VIOLATION });
  });

  it('transação terminal não aceita nenhuma alteração, nem fora do status', async () => {
    const wallet = await newWallet();
    const tx = await newTx(wallet.id, processed);
    await expect(db.query(`UPDATE wager_transactions SET amount = 999 WHERE id = $1`, [tx.id])).rejects.toMatchObject({
      code: RESTRICT_VIOLATION,
    });
  });

  it('campos de negócio não mudam nem enquanto PENDING', async () => {
    const wallet = await newWallet();
    const tx = await newTx(wallet.id);
    for (const change of [`amount = 999`, `kind = 'WIN'`, `wallet_id = '${uuid()}'`, `payload_hash = 'outro'`]) {
      await expect(db.query(`UPDATE wager_transactions SET ${change} WHERE id = $1`, [tx.id])).rejects.toMatchObject({
        code: RESTRICT_VIOLATION,
      });
    }
  });

  it('status não terminal pode avançar', async () => {
    const wallet = await newWallet();
    const tx = await newTx(wallet.id);
    await db.query(`UPDATE wager_transactions SET status = 'PROCESSED', processed_at = now(), balance_after = 90 WHERE id = $1`, [tx.id]);
  });

  it('transação não pode ser apagada', async () => {
    const wallet = await newWallet();
    const tx = await newTx(wallet.id);
    await expect(db.query(`DELETE FROM wager_transactions WHERE id = $1`, [tx.id])).rejects.toMatchObject({
      code: RESTRICT_VIOLATION,
    });
  });
});

describe('wallet_ledger_entries', () => {
  async function walletWithProcessedTx() {
    const wallet = await newWallet();
    const tx = await newTx(wallet.id, processed);
    return { wallet, tx };
  }

  it('aceita lançamento consistente e gera sequence crescente', async () => {
    const { wallet, tx } = await walletWithProcessedTx();
    const tx2 = await newTx(wallet.id, processed);
    await insert(db, 'wallet_ledger_entries', ledgerRow(wallet.id, tx.id));
    await insert(db, 'wallet_ledger_entries', ledgerRow(wallet.id, tx2.id, { balance_before: '90.00', balance_after: '80.00' }));

    const { rows } = await db.query<{ sequence: string }>(
      `SELECT sequence FROM wallet_ledger_entries WHERE wallet_id = $1 ORDER BY sequence`,
      [wallet.id],
    );
    expect(rows).toHaveLength(2);
    expect(BigInt(rows[1]!.sequence)).toBeGreaterThan(BigInt(rows[0]!.sequence));
  });

  it('aritmética tem que fechar (before ± amount = after)', async () => {
    const { wallet, tx } = await walletWithProcessedTx();
    await expect(
      insert(db, 'wallet_ledger_entries', ledgerRow(wallet.id, tx.id, { balance_after: '95.00' })),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION, constraint: 'ledger_arithmetic_ck' });
  });

  it('valor positivo e saldos não negativos', async () => {
    const { wallet, tx } = await walletWithProcessedTx();
    await expect(
      insert(db, 'wallet_ledger_entries', ledgerRow(wallet.id, tx.id, { amount: '0.00', balance_after: '100.00' })),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });
    await expect(
      insert(db, 'wallet_ledger_entries', ledgerRow(wallet.id, tx.id, { balance_before: '5.00', balance_after: '-5.00' })),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });
  });

  it('no máximo um lançamento por transação', async () => {
    const { wallet, tx } = await walletWithProcessedTx();
    await insert(db, 'wallet_ledger_entries', ledgerRow(wallet.id, tx.id));
    await expect(insert(db, 'wallet_ledger_entries', ledgerRow(wallet.id, tx.id))).rejects.toMatchObject({
      code: UNIQUE_VIOLATION,
      constraint: 'ledger_transaction_uk',
    });
  });

  it('lançamento e transação tem que ser da msm wallet', async () => {
    const { tx } = await walletWithProcessedTx();
    const other = await newWallet();
    await expect(insert(db, 'wallet_ledger_entries', ledgerRow(other.id, tx.id))).rejects.toMatchObject({
      code: FOREIGN_KEY_VIOLATION,
    });
  });

  it('moeda do lançamento tem que ser a da wallet', async () => {
    const { wallet, tx } = await walletWithProcessedTx();
    await expect(
      insert(db, 'wallet_ledger_entries', ledgerRow(wallet.id, tx.id, { currency: 'USD' })),
    ).rejects.toMatchObject({ code: FOREIGN_KEY_VIOLATION, constraint: 'ledger_wallet_currency_fk' });
  });

  it('é append-only: UPDATE, DELETE e TRUNCATE são bloqueados', async () => {
    const { wallet, tx } = await walletWithProcessedTx();
    const entry = ledgerRow(wallet.id, tx.id);
    await insert(db, 'wallet_ledger_entries', entry);

    await expect(
      db.query(`UPDATE wallet_ledger_entries SET amount = 1 WHERE id = $1`, [entry.id]),
    ).rejects.toMatchObject({ code: RESTRICT_VIOLATION });
    await expect(db.query(`DELETE FROM wallet_ledger_entries WHERE id = $1`, [entry.id])).rejects.toMatchObject({
      code: RESTRICT_VIOLATION,
    });
    await expect(db.query(`TRUNCATE wallet_ledger_entries CASCADE`)).rejects.toMatchObject({
      code: RESTRICT_VIOLATION,
    });
  });
});

describe('inbox_messages', () => {
  it('deduplica por consumer + messageId', async () => {
    const row = { consumer_name: 'wager-consumer', message_id: `msg-${++sequence}`, payload_hash: 'h', received_at: NOW };
    await insert(db, 'inbox_messages', row);
    await expect(insert(db, 'inbox_messages', row)).rejects.toMatchObject({ code: UNIQUE_VIOLATION });
    // msm mensagem em outro consumer eh outro registro
    await insert(db, 'inbox_messages', { ...row, consumer_name: 'outro-consumer' });
  });
});

describe('outbox_messages', () => {
  const outboxRow = (o: Record<string, unknown> = {}) => ({
    id: uuid(),
    aggregate_id: uuid(),
    event_type: 'WagerTransactionProcessed',
    payload: JSON.stringify({ eventId: 'x' }),
    occurred_at: NOW,
    ...o,
  });

  it('aceita evento novo com attempts 0 e sem published_at', async () => {
    const row = outboxRow();
    await insert(db, 'outbox_messages', row);
    const { rows } = await db.query<{ attempts: number; published_at: Date | null }>(
      `SELECT attempts, published_at FROM outbox_messages WHERE id = $1`,
      [row.id],
    );
    expect(rows[0]).toEqual({ attempts: 0, published_at: null });
  });

  it('attempts não pode ser negativo', async () => {
    await expect(insert(db, 'outbox_messages', outboxRow({ attempts: -1 }))).rejects.toMatchObject({
      code: CHECK_VIOLATION,
    });
  });
});
