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

type Wallet = { id: string; playerId: string };
const brl = (amount: string) => ({ amount, currency: 'BRL' });

async function createWallet(amount = '100.00'): Promise<Wallet> {
  const res = await api.post('/wallets', { playerId: crypto.randomUUID(), initialBalance: brl(amount) });
  expect(res.status).toBe(201);
  return res.body;
}

function wager(wallet: Wallet, overrides: Record<string, unknown> = {}) {
  return {
    providerId: 'provider-a',
    externalTransactionId: `tx-${crypto.randomUUID()}`,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'round-1',
    gameId: 'tigrao',
    kind: 'BET',
    money: brl('10.00'),
    ...overrides,
  };
}

function submit(body: Record<string, unknown>, key = `${body.providerId}:${body.externalTransactionId}`) {
  return api.post('/wagering/transactions', body, { 'Idempotency-Key': key });
}

async function balanceOf(wallet: Wallet): Promise<string> {
  return (await api.get(`/wallets/${wallet.id}`)).body.balance.amount;
}

async function debitsOf(wallet: Wallet): Promise<number> {
  const { rows } = await db.query<{ n: string }>(
    `SELECT count(*) AS n FROM wallet_ledger_entries WHERE wallet_id = $1 AND direction = 'DEBIT'`,
    [wallet.id],
  );
  return Number(rows[0]!.n);
}

async function assertLedgerConsistent(wallet: Wallet) {
  const res = await api.post(`/wallets/${wallet.id}/reconciliation`);
  expect(res.body.consistent).toBe(true);
}

describe('POST /wagering/transactions', () => {
  it('BET processada debita e devolve o saldo', async () => {
    const wallet = await createWallet('1000.00');
    const res = await submit(wager(wallet, { money: brl('25.00') }));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      transactionId: expect.any(String),
      status: 'PROCESSED',
      balance: brl('975.00'),
      idempotentReplay: false,
    });
    await assertLedgerConsistent(wallet);
  });

  describe('idempotência', () => {
    it('requisição idêntica devolve o resultado original com idempotentReplay true', async () => {
      const wallet = await createWallet('100.00');
      const body = wager(wallet, { money: brl('30.00') });
      const original = await submit(body);
      await submit(wager(wallet, { money: brl('10.00') })); // saldo muda depois

      const replay = await submit(body);
      expect(replay.status).toBe(original.status);
      expect(replay.body).toEqual({ ...original.body, idempotentReplay: true });
      expect(replay.body.balance).toEqual(brl('70.00')); // saldo de quando foi processada
      expect(await debitsOf(wallet)).toBe(2);
    });

    it('msm key com payload diferente é conflito, não replay', async () => {
      const wallet = await createWallet('100.00');
      const body = wager(wallet);
      await submit(body);

      const res = await submit({ ...body, money: brl('99.00') });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_CONFLICT');
      expect(await balanceOf(wallet)).toBe('90.00');
    });

    it('msm externalTransactionId com outra key também é conflito', async () => {
      const wallet = await createWallet('100.00');
      const body = wager(wallet);
      await submit(body);
      const res = await submit(body, 'outra-key');
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_CONFLICT');
    });

    it('sem Idempotency-Key é 400', async () => {
      const wallet = await createWallet();
      const res = await api.post('/wagering/transactions', wager(wallet));
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_PAYLOAD');
    });

    it('rejeição também é replay estável', async () => {
      const wallet = await createWallet('5.00');
      const body = wager(wallet, { money: brl('10.00') });
      const original = await submit(body);
      const replay = await submit(body);
      expect(replay.status).toBe(422);
      expect(replay.body).toEqual({ ...original.body, idempotentReplay: true });
    });
  });

  describe('regras de negócio', () => {
    it('saldo insuficiente é 422 REJECTED com INSUFFICIENT_FUNDS e não mexe no saldo', async () => {
      const wallet = await createWallet('5.00');
      const res = await submit(wager(wallet, { money: brl('10.00') }));
      expect(res.status).toBe(422);
      expect(res.body).toEqual({
        transactionId: expect.any(String),
        status: 'REJECTED',
        failureCode: 'INSUFFICIENT_FUNDS',
        balance: brl('5.00'),
        idempotentReplay: false,
      });
      expect(await debitsOf(wallet)).toBe(0);
    });

    it('LOSS processa sem mexer no saldo', async () => {
      const wallet = await createWallet('100.00');
      const res = await submit(wager(wallet, { kind: 'LOSS', money: brl('0.00') }));
      expect(res.status).toBe(200);
      expect(res.body.balance).toEqual(brl('100.00'));
    });

    it('REFUND de BET processada devolve o valor', async () => {
      const wallet = await createWallet('100.00');
      const bet = wager(wallet, { money: brl('40.00') });
      await submit(bet);
      const res = await submit(
        wager(wallet, { kind: 'REFUND', money: brl('40.00'), referenceExternalTransactionId: bet.externalTransactionId }),
      );
      expect(res.status).toBe(200);
      expect(res.body.balance).toEqual(brl('100.00'));
      await assertLedgerConsistent(wallet);
    });

    it('ROLLBACK de WIN que estouraria o saldo é 422 REVERSAL_WOULD_OVERDRAW', async () => {
      const wallet = await createWallet('0.00');
      const win = wager(wallet, { kind: 'WIN', money: brl('50.00') });
      await submit(win);
      await submit(wager(wallet, { money: brl('45.00') }));
      const res = await submit(
        wager(wallet, { kind: 'ROLLBACK', money: brl('50.00'), referenceExternalTransactionId: win.externalTransactionId }),
      );
      expect(res.status).toBe(422);
      expect(res.body.failureCode).toBe('REVERSAL_WOULD_OVERDRAW');
    });

    it('moeda diferente da wallet é 422 CURRENCY_MISMATCH', async () => {
      const wallet = await createWallet('100.00');
      const res = await submit(wager(wallet, { money: { amount: '10.00', currency: 'USD' } }));
      expect(res.status).toBe(422);
      expect(res.body.failureCode).toBe('CURRENCY_MISMATCH');
    });

    it('REFUND antes da BET fica PENDING_REFERENCE com 202', async () => {
      const wallet = await createWallet('100.00');
      const res = await submit(
        wager(wallet, { kind: 'REFUND', money: brl('10.00'), referenceExternalTransactionId: 'bet-que-nao-chegou' }),
      );
      expect(res.status).toBe(202);
      expect(res.body).toMatchObject({ status: 'PENDING_REFERENCE', balance: null, idempotentReplay: false });
    });
  });

  describe('validação', () => {
    it('wallet inexistente é 404', async () => {
      const wallet = { id: crypto.randomUUID(), playerId: crypto.randomUUID() };
      const res = await submit(wager(wallet));
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('WALLET_NOT_FOUND');
    });

    it.each([
      ['OPENING é interno', { kind: 'OPENING' }],
      ['kind desconhecido', { kind: 'JACKPOT' }],
      ['REFUND sem referência', { kind: 'REFUND' }],
      ['amount com 3 casas', { money: brl('1.005') }],
      ['amount em notação científica', { money: brl('1e3') }],
      ['walletId que não é uuid', { walletId: 'abc' }],
    ])('%s é 400', async (_, overrides) => {
      const wallet = await createWallet();
      const res = await submit(wager(wallet, overrides));
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_PAYLOAD');
    });
  });

  describe('outbox na msm transação', () => {
    async function eventsOf(transactionId: string): Promise<string[]> {
      const { rows } = await db.query<{ event_type: string }>(
        `SELECT event_type FROM outbox_messages WHERE payload -> 'data' ->> 'transactionId' = $1 ORDER BY sequence`,
        [transactionId],
      );
      return rows.map((r) => r.event_type);
    }

    it('BET gera WagerTransactionProcessed e WalletBalanceChanged', async () => {
      const wallet = await createWallet('100.00');
      const res = await submit(wager(wallet));
      expect(await eventsOf(res.body.transactionId)).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
    });

    it('LOSS gera só WagerTransactionProcessed', async () => {
      const wallet = await createWallet('100.00');
      const res = await submit(wager(wallet, { kind: 'LOSS' }));
      expect(await eventsOf(res.body.transactionId)).toEqual(['WagerTransactionProcessed']);
    });

    it('rejeição gera WagerTransactionRejected', async () => {
      const wallet = await createWallet('1.00');
      const res = await submit(wager(wallet));
      expect(await eventsOf(res.body.transactionId)).toEqual(['WagerTransactionRejected']);
    });

    it('referência ausente gera WagerTransactionPendingReference', async () => {
      const wallet = await createWallet('100.00');
      const res = await submit(wager(wallet, { kind: 'REFUND', referenceExternalTransactionId: 'nao-chegou' }));
      expect(await eventsOf(res.body.transactionId)).toEqual(['WagerTransactionPendingReference']);
    });
  });

  describe('concorrência (paralelismo real)', () => {
    it('saldo 100.00 e duas BETs de 80.00 simultâneas: uma passa, outra é rejeitada, saldo 20.00', async () => {
      const wallet = await createWallet('100.00');
      const results = await Promise.all([
        submit(wager(wallet, { money: brl('80.00') })),
        submit(wager(wallet, { money: brl('80.00') })),
      ]);

      expect(results.map((r) => r.status).sort()).toEqual([200, 422]);
      expect(results.find((r) => r.status === 422)!.body.failureCode).toBe('INSUFFICIENT_FUNDS');
      expect(await balanceOf(wallet)).toBe('20.00');
      expect(await debitsOf(wallet)).toBe(1);
      await assertLedgerConsistent(wallet);
    });

    it('wallet travada por tempo demais devolve 503 em vez de prender a conexão', async () => {
      const wallet = await createWallet('100.00');
      const body = wager(wallet);

      // outra conexão segura o lock da wallet, simulando uma transação lenta
      const locker = await connect();
      await locker.query('BEGIN');
      await locker.query('SELECT 1 FROM wallets WHERE id = $1 FOR UPDATE', [wallet.id]);
      try {
        const res = await submit(body);
        expect(res.status).toBe(503);
        expect(res.body.error.code).toBe('SERVICE_UNAVAILABLE');
      } finally {
        await locker.query('ROLLBACK');
        await locker.end();
      }

      // nada foi gravado, então reenviar processa normal e não é replay
      const retry = await submit(body);
      expect(retry.status).toBe(200);
      expect(retry.body.idempotentReplay).toBe(false);
    });

    it('a msm BET enviada 50 vezes em paralelo debita uma vez só', async () => {
      const wallet = await createWallet('100.00');
      const body = wager(wallet, { money: brl('10.00') });
      const results = await Promise.all(Array.from({ length: 50 }, () => submit(body)));

      expect(results.every((r) => r.status === 200)).toBe(true);
      expect(results.filter((r) => r.body.idempotentReplay === false)).toHaveLength(1);
      expect(new Set(results.map((r) => r.body.transactionId)).size).toBe(1);
      expect(await balanceOf(wallet)).toBe('90.00');
      expect(await debitsOf(wallet)).toBe(1);
    });
  });
});

describe('consultas de transação', () => {
  it('por id interno e por provider + externalTransactionId', async () => {
    const wallet = await createWallet('100.00');
    const body = wager(wallet, { money: brl('15.00') });
    const created = await submit(body);

    const byId = await api.get(`/wagering/transactions/${created.body.transactionId}`);
    expect(byId.status).toBe(200);
    expect(byId.body).toMatchObject({
      transactionId: created.body.transactionId,
      providerId: 'provider-a',
      externalTransactionId: body.externalTransactionId,
      walletId: wallet.id,
      kind: 'BET',
      money: brl('15.00'),
      status: 'PROCESSED',
      failureCode: null,
      balance: brl('85.00'),
    });

    const byExternal = await api.get(`/providers/provider-a/wagering/transactions/${body.externalTransactionId}`);
    expect(byExternal.status).toBe(200);
    expect(byExternal.body).toEqual(byId.body);
  });

  it('transação inexistente é 404', async () => {
    expect((await api.get(`/wagering/transactions/${crypto.randomUUID()}`)).status).toBe(404);
    expect((await api.get(`/providers/provider-a/wagering/transactions/nao-existe`)).status).toBe(404);
  });
});
