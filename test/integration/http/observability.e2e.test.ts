import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { SQSClient } from '@aws-sdk/client-sqs';
import type { Client } from 'pg';
import { createSqsClient } from '../../../src/infrastructure/messaging/sqs-client';
import { connect, migrate, walletsOutOfBalance } from '../support/database';
import { startTestApp, type TestApp } from '../support/http';
import { deadLetterQueueUrl, purgeQueue, sendToQueue, wagerQueueUrl } from '../support/sqs';

let api: TestApp;
let db: Client;
let sqs: SQSClient;
const logs: string[] = [];

beforeAll(async () => {
  await migrate('down');
  await migrate('up');
  db = await connect();
  sqs = createSqsClient();
  await purgeQueue(sqs, wagerQueueUrl());
  await purgeQueue(sqs, deadLetterQueueUrl());
  // publisher desligado de propósito: os eventos ficam pendentes e o outbox lag aparece
  api = await startTestApp({ sqsConsumer: true, logs });
}, 30_000);

afterAll(async () => {
  await api?.close();
  await db?.end();
  sqs?.destroy();
});

type Wallet = { id: string; playerId: string };
const brl = (amount: string) => ({ amount, currency: 'BRL' });

async function createWallet(amount = '100.00'): Promise<Wallet> {
  const res = await api.post('/wallets', { playerId: crypto.randomUUID(), initialBalance: brl(amount) });
  expect(res.status).toBe(201);
  return res.body;
}

function wager(wallet: Wallet, overrides: Record<string, unknown> = {}) {
  return {
    providerId: 'provider-obs',
    externalTransactionId: `tx-${crypto.randomUUID()}`,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'round-1',
    gameId: 'tigrao',
    kind: 'BET',
    money: brl('25.00'),
    ...overrides,
  };
}

const submit = (body: Record<string, unknown>, headers: Record<string, string> = {}) =>
  api.post('/wagering/transactions', body, {
    'Idempotency-Key': `${body.providerId}:${body.externalTransactionId}`,
    ...headers,
  });

// soma o valor das séries da métrica que batem com os labels pedidos
async function metric(name: string, labels: Record<string, string> = {}): Promise<number> {
  const res = await api.get('/metrics');
  let total = 0;
  for (const line of res.text.split('\n')) {
    if (!line.startsWith(name) || line.startsWith('#')) continue;
    const match = /^([a-z_]+)(\{([^}]*)\})?\s+(\S+)$/.exec(line);
    if (!match || match[1] !== name) continue;
    const series = Object.fromEntries(
      (match[3] ?? '')
        .split(',')
        .filter(Boolean)
        .map((pair) => {
          const [key, value] = pair.split('=');
          return [key!, value!.replace(/"/g, '')];
        }),
    );
    if (Object.entries(labels).every(([key, value]) => series[key] === value)) total += Number(match[4]);
  }
  return total;
}

const parsedLogs = () => logs.map((line) => JSON.parse(line) as Record<string, unknown>);

describe('métricas em /metrics', () => {
  it('expõe no formato do Prometheus, sem autenticação', async () => {
    const res = await api.get('/metrics');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    for (const name of [
      'wagering_transactions_total',
      'wagering_duplicates_total',
      'wagering_retries_total',
      'wagering_dead_letters_total',
      'wagering_lock_conflicts_total',
      'wagering_outbox_pending',
      'wagering_outbox_lag_seconds',
      'wagering_dlq_depth',
      'wagering_processing_duration_seconds',
      'wagering_reconciliation_divergences_total',
    ]) {
      expect(res.text).toContain(`# TYPE ${name}`);
    }
  });

  it('conta transações por canal, kind e status', async () => {
    const processed = { channel: 'http', kind: 'BET', status: 'PROCESSED' };
    const rejected = { channel: 'http', kind: 'BET', status: 'REJECTED' };
    const before = { processed: await metric('wagering_transactions_total', processed), rejected: await metric('wagering_transactions_total', rejected) };

    const wallet = await createWallet('30.00');
    expect((await submit(wager(wallet))).status).toBe(200);
    expect((await submit(wager(wallet))).status).toBe(422);

    expect(await metric('wagering_transactions_total', processed)).toBe(before.processed + 1);
    expect(await metric('wagering_transactions_total', rejected)).toBe(before.rejected + 1);
  });

  it('mede a latência do processamento', async () => {
    const before = await metric('wagering_processing_duration_seconds_count', { channel: 'http' });
    await submit(wager(await createWallet()));
    expect(await metric('wagering_processing_duration_seconds_count', { channel: 'http' })).toBe(before + 1);
  });

  it('conta replay como duplicata detectada', async () => {
    const before = await metric('wagering_duplicates_total', { type: 'idempotent_replay' });
    const body = wager(await createWallet());
    await submit(body);
    await submit(body);
    await submit(body);
    expect(await metric('wagering_duplicates_total', { type: 'idempotent_replay' })).toBe(before + 2);
  });

  it('conta conflito de lock quando a wallet fica travada além do timeout', async () => {
    const before = await metric('wagering_lock_conflicts_total', { type: 'lock_timeout' });
    const wallet = await createWallet();
    const locker = await connect();
    await locker.query('BEGIN');
    await locker.query('SELECT 1 FROM wallets WHERE id = $1 FOR UPDATE', [wallet.id]);
    try {
      expect((await submit(wager(wallet))).status).toBe(503);
    } finally {
      await locker.query('ROLLBACK');
      await locker.end();
    }
    expect(await metric('wagering_lock_conflicts_total', { type: 'lock_timeout' })).toBe(before + 1);
  });

  it('mostra eventos pendentes na outbox e há quanto tempo o mais velho espera', async () => {
    await submit(wager(await createWallet()));
    await Bun.sleep(1_100);
    expect(await metric('wagering_outbox_pending')).toBeGreaterThan(0);
    expect(await metric('wagering_outbox_lag_seconds')).toBeGreaterThanOrEqual(1);
  });

  it('conta divergência de reconciliação', async () => {
    const before = await metric('wagering_reconciliation_divergences_total');
    const wallet = await createWallet();
    await db.query('UPDATE wallets SET balance = balance + 1 WHERE id = $1', [wallet.id]);
    await api.post(`/wallets/${wallet.id}/reconciliation`);
    expect(await metric('wagering_reconciliation_divergences_total')).toBe(before + 1);
    // desfaz a corrupção pra não sujar o invariante final do arquivo
    await db.query('UPDATE wallets SET balance = balance - 1 WHERE id = $1', [wallet.id]);
  });

  it('conta mensagem mandada pra DLQ e mostra a profundidade da DLQ', async () => {
    const before = await metric('wagering_dead_letters_total');
    await sendToQueue(sqs, wagerQueueUrl(), '{ isso não é json');

    const deadline = Date.now() + 10_000;
    while ((await metric('wagering_dead_letters_total')) === before && Date.now() < deadline) await Bun.sleep(100);

    expect(await metric('wagering_dead_letters_total')).toBe(before + 1);
    expect(await metric('wagering_dlq_depth')).toBeGreaterThanOrEqual(1);
  }, 15_000);
});

describe('logs estruturados', () => {
  it('cada requisição http gera uma linha JSON com correlationId, ids e status, e devolve o correlationId', async () => {
    const wallet = await createWallet();
    const body = wager(wallet);
    const res = await submit(body, { 'x-correlation-id': 'corr-observability-1' });
    expect(res.headers.get('x-correlation-id')).toBe('corr-observability-1');

    const line = parsedLogs().find((entry) => entry.correlationId === 'corr-observability-1' && entry.msg === 'http request');
    expect(line).toMatchObject({
      level: 'info',
      method: 'POST',
      path: '/wagering/transactions',
      status: 200,
      walletId: wallet.id,
      providerId: 'provider-obs',
      transactionId: res.body.transactionId,
    });
    expect(typeof line!.durationMs).toBe('number');
  });

  it('gera correlationId quando o cliente não manda', async () => {
    const res = await api.get('/health/live');
    expect(res.headers.get('x-correlation-id')).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('mensagem da fila gera log com messageId, correlationId e ids da transação', async () => {
    const wallet = await createWallet();
    const externalTransactionId = `tx-${crypto.randomUUID()}`;
    const messageId = `msg-${crypto.randomUUID()}`;
    await sendToQueue(
      sqs,
      wagerQueueUrl(),
      {
        messageId,
        type: 'WagerTransactionRequested',
        occurredAt: new Date().toISOString(),
        data: { ...wager(wallet, { externalTransactionId }), idempotencyKey: `provider-obs:${externalTransactionId}` },
      },
      { groupId: wallet.id },
    );

    const deadline = Date.now() + 10_000;
    let line: Record<string, unknown> | undefined;
    while (!line && Date.now() < deadline) {
      await Bun.sleep(100);
      line = parsedLogs().find((entry) => entry.messageId === messageId && entry.outcome === 'ack');
    }
    expect(line).toMatchObject({ messageId, correlationId: messageId, walletId: wallet.id, providerId: 'provider-obs' });
    expect(typeof line!.transactionId).toBe('string');
  }, 15_000);

  it('nenhuma linha de log carrega valor monetário', async () => {
    // 25.00 é o valor de toda aposta deste arquivo e 100.00 o saldo inicial das wallets
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.some((line) => line.includes('25.00') || line.includes('100.00') || line.includes('75.00'))).toBe(false);
  });
});

describe('invariante final', () => {
  it('toda wallet do banco tem saldo igual ao reconstruído pelo ledger', async () => {
    expect(await walletsOutOfBalance(db)).toEqual([]);
  });
});
