import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Client } from 'pg';
import { connect, migrate } from '../support/database';
import { startTestApp, type TestApp } from '../support/http';

let api: TestApp;
let db: Client;

beforeAll(async () => {
  await migrate('down');
  await migrate('up');
  api = await startTestApp();
  db = await connect();
});

afterAll(async () => {
  await db?.end();
  await api?.close();
});

const brl = (amount: string) => ({ amount, currency: 'BRL' });

async function createWallet(amount = '100.00', playerId: string = crypto.randomUUID()) {
  const res = await api.post('/wallets', { playerId, initialBalance: brl(amount) });
  expect(res.status).toBe(201);
  return res.body as { id: string; playerId: string; balance: { amount: string; currency: string }; version: number };
}

async function bet(wallet: { id: string; playerId: string }, amount: string) {
  const externalTransactionId = `tx-${crypto.randomUUID()}`;
  return api.post(
    '/wagering/transactions',
    {
      providerId: 'provider-a',
      externalTransactionId,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'round-1',
      gameId: 'tigrao',
      kind: 'BET',
      money: brl(amount),
    },
    { 'Idempotency-Key': `provider-a:${externalTransactionId}` },
  );
}

describe('POST /wallets', () => {
  it('cria wallet com saldo inicial, version 1 e lançamento de abertura', async () => {
    const playerId = crypto.randomUUID();
    const res = await api.post('/wallets', { playerId, initialBalance: brl('1000.00') });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ id: expect.any(String), playerId, balance: brl('1000.00'), version: 1 });

    const ledger = await api.get(`/wallets/${res.body.id}/ledger`);
    expect(ledger.status).toBe(200);
    expect(ledger.body.items).toHaveLength(1);
    expect(ledger.body.items[0]).toMatchObject({
      direction: 'CREDIT',
      money: brl('1000.00'),
      balanceBefore: brl('0.00'),
      balanceAfter: brl('1000.00'),
    });
  });

  it('saldo inicial zero não gera lançamento', async () => {
    const wallet = await createWallet('0.00');
    const ledger = await api.get(`/wallets/${wallet.id}/ledger`);
    expect(ledger.body.items).toEqual([]);
  });

  it('wallet duplicada pra msm player e moeda é conflito', async () => {
    const wallet = await createWallet();
    const res = await api.post('/wallets', { playerId: wallet.playerId, initialBalance: brl('5.00') });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('WALLET_ALREADY_EXISTS');
  });

  it('msm player em outra moeda pode', async () => {
    const wallet = await createWallet();
    const res = await api.post('/wallets', {
      playerId: wallet.playerId,
      initialBalance: { amount: '5.00', currency: 'USD' },
    });
    expect(res.status).toBe(201);
  });

  it.each([
    ['playerId que não é uuid', { playerId: 'abc', initialBalance: brl('1.00') }],
    ['amount sem casas decimais', { playerId: crypto.randomUUID(), initialBalance: brl('10') }],
    ['amount negativo', { playerId: crypto.randomUUID(), initialBalance: brl('-1.00') }],
    ['moeda minúscula', { playerId: crypto.randomUUID(), initialBalance: { amount: '1.00', currency: 'brl' } }],
    ['sem initialBalance', { playerId: crypto.randomUUID() }],
    ['campo desconhecido', { playerId: crypto.randomUUID(), initialBalance: brl('1.00'), admin: true }],
  ])('payload inválido (%s) é 400', async (_, payload) => {
    const res = await api.post('/wallets', payload);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_PAYLOAD');
  });
});

describe('GET /wallets/:walletId', () => {
  it('devolve a wallet', async () => {
    const wallet = await createWallet('42.00');
    const res = await api.get(`/wallets/${wallet.id}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(wallet);
  });

  it('wallet inexistente é 404', async () => {
    const res = await api.get(`/wallets/${crypto.randomUUID()}`);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('WALLET_NOT_FOUND');
  });

  it('id que não é uuid é 400', async () => {
    const res = await api.get('/wallets/abc');
    expect(res.status).toBe(400);
  });
});

describe('GET /wallets/:walletId/ledger', () => {
  it('pagina com cursor estável e opaco', async () => {
    const wallet = await createWallet('100.00');
    for (const amount of ['10.00', '20.00', '30.00']) expect((await bet(wallet, amount)).status).toBe(200);

    const first = await api.get(`/wallets/${wallet.id}/ledger?limit=2`);
    expect(first.status).toBe(200);
    expect(first.body.items.map((i: { money: { amount: string } }) => i.money.amount)).toEqual(['100.00', '10.00']);
    expect(typeof first.body.nextCursor).toBe('string');

    const second = await api.get(`/wallets/${wallet.id}/ledger?limit=2&cursor=${first.body.nextCursor}`);
    expect(second.body.items.map((i: { money: { amount: string } }) => i.money.amount)).toEqual(['20.00', '30.00']);
    expect(second.body.nextCursor).toBeNull();
  });

  it('limit default é 50', async () => {
    const wallet = await createWallet('10.00');
    const res = await api.get(`/wallets/${wallet.id}/ledger`);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.nextCursor).toBeNull();
  });

  it.each(['cursor=lixo', 'limit=0', 'limit=201', 'limit=abc'])('parâmetro inválido (%s) é 400', async (query) => {
    const wallet = await createWallet('10.00');
    const res = await api.get(`/wallets/${wallet.id}/ledger?${query}`);
    expect(res.status).toBe(400);
  });

  it('wallet inexistente é 404', async () => {
    const res = await api.get(`/wallets/${crypto.randomUUID()}/ledger`);
    expect(res.status).toBe(404);
  });
});

describe('POST /wallets/:walletId/reconciliation', () => {
  it('saldo bate com o ledger', async () => {
    const wallet = await createWallet('100.00');
    await bet(wallet, '25.00');
    const res = await api.post(`/wallets/${wallet.id}/reconciliation`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      walletId: wallet.id,
      storedBalance: brl('75.00'),
      calculatedBalance: brl('75.00'),
      difference: brl('0.00'),
      consistent: true,
      checkedEntries: 2,
    });
  });

  it('divergência é sinalizada e não corrigida', async () => {
    const wallet = await createWallet('100.00');
    // simula corrupção: mexe no saldo sem lançamento
    await db.query(`UPDATE wallets SET balance = balance + 5 WHERE id = $1`, [wallet.id]);

    const res = await api.post(`/wallets/${wallet.id}/reconciliation`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      storedBalance: brl('105.00'),
      calculatedBalance: brl('100.00'),
      difference: brl('5.00'),
      consistent: false,
    });

    // continua divergente, nada foi corrigido em silêncio
    expect((await api.get(`/wallets/${wallet.id}`)).body.balance).toEqual(brl('105.00'));
  });

  it('wallet inexistente é 404', async () => {
    const res = await api.post(`/wallets/${crypto.randomUUID()}/reconciliation`);
    expect(res.status).toBe(404);
  });
});

describe('GET /health', () => {
  it('live responde sem depender de nada', async () => {
    expect((await api.get('/health/live')).status).toBe(200);
  });

  it('ready confere o banco', async () => {
    const res = await api.get('/health/ready');
    expect(res.status).toBe(200);
    expect(res.body.checks.postgres).toBe('up');
  });
});
