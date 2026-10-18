import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { migrate } from '../support/database';
import { startTestApp, type TestApp } from '../support/http';

let api: TestApp;

beforeAll(async () => {
  await migrate('down');
  await migrate('up');
  api = await startTestApp({ pendingReferenceWorker: true });
});

afterAll(async () => {
  await api?.close();
});

describe('worker de referências pendentes dentro da aplicação', () => {
  it('REFUND enviado antes da BET fica 202 e termina PROCESSED sozinho quando a BET chega', async () => {
    const wallet = await api.post('/wallets', {
      playerId: crypto.randomUUID(),
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });
    const base = {
      providerId: 'provider-a',
      playerId: wallet.body.playerId,
      walletId: wallet.body.id,
      roundId: 'round-1',
      gameId: 'tigrao',
      money: { amount: '40.00', currency: 'BRL' },
    };
    const betId = `bet-${crypto.randomUUID()}`;
    const refundId = `refund-${crypto.randomUUID()}`;

    const refund = await api.post(
      '/wagering/transactions',
      { ...base, kind: 'REFUND', externalTransactionId: refundId, referenceExternalTransactionId: betId },
      { 'Idempotency-Key': `provider-a:${refundId}` },
    );
    expect(refund.status).toBe(202);

    const bet = await api.post(
      '/wagering/transactions',
      { ...base, kind: 'BET', externalTransactionId: betId },
      { 'Idempotency-Key': `provider-a:${betId}` },
    );
    expect(bet.status).toBe(200);
    expect(bet.body.balance).toEqual({ amount: '60.00', currency: 'BRL' });

    // primeira nova tentativa sai depois de 2s de backoff
    const deadline = Date.now() + 10_000;
    let current = await api.get(`/wagering/transactions/${refund.body.transactionId}`);
    while (current.body.status === 'PENDING_REFERENCE' && Date.now() < deadline) {
      await Bun.sleep(100);
      current = await api.get(`/wagering/transactions/${refund.body.transactionId}`);
    }

    expect(current.body.status).toBe('PROCESSED');
    expect(current.body.referenceTransactionId).toBe(bet.body.transactionId);
    expect((await api.get(`/wallets/${wallet.body.id}`)).body.balance).toEqual({ amount: '100.00', currency: 'BRL' });
    expect((await api.post(`/wallets/${wallet.body.id}/reconciliation`)).body.consistent).toBe(true);
  }, 15_000);
});
