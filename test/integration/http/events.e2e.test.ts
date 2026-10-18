import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { createSqsClient } from '../../../src/infrastructure/messaging/sqs-client';
import { connect, migrate, walletsOutOfBalance } from '../support/database';
import { startTestApp, type TestApp } from '../support/http';
import { eventsQueueUrl, purgeQueue, receiveAll } from '../support/sqs';

let api: TestApp;
let sqs: SQSClient;

beforeAll(async () => {
  await migrate('down');
  await migrate('up');
  sqs = createSqsClient();
  await purgeQueue(sqs, eventsQueueUrl());
  api = await startTestApp({ outboxPublisher: true });
});

afterAll(async () => {
  await api?.close();
  sqs?.destroy();
});

describe('eventos de ponta a ponta', () => {
  it('aposta feita pela api chega sozinha na fila de eventos depois do commit', async () => {
    const wallet = await api.post('/wallets', {
      playerId: crypto.randomUUID(),
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });
    const externalTransactionId = `tx-${crypto.randomUUID()}`;
    const bet = await api.post(
      '/wagering/transactions',
      {
        providerId: 'provider-a',
        externalTransactionId,
        playerId: wallet.body.playerId,
        walletId: wallet.body.id,
        roundId: 'round-1',
        gameId: 'tigrao',
        kind: 'BET',
        money: { amount: '25.00', currency: 'BRL' },
      },
      { 'Idempotency-Key': `provider-a:${externalTransactionId}` },
    );
    expect(bet.status).toBe(200);

    // o worker publica em segundo plano, espera os eventos da aposta aparecerem
    const received: { eventType: string; data: { transactionId?: string } }[] = [];
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const batch = await receiveAll(sqs, eventsQueueUrl());
      received.push(...batch.map((m) => JSON.parse(m.Body!)));
      if (received.filter((e) => e.data.transactionId === bet.body.transactionId).length >= 2) break;
    }

    const betEvents = received.filter((e) => e.data.transactionId === bet.body.transactionId).map((e) => e.eventType);
    expect(betEvents.sort()).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
  }, 15_000);

  it('readiness confere o postgres e o sqs', async () => {
    const res = await api.get('/health/ready');
    expect(res.status).toBe(200);
    expect(res.body.checks).toEqual({ postgres: 'up', sqs: 'up' });
  });
});

describe('invariante final', () => {
  it('toda wallet do banco tem saldo igual ao reconstruído pelo ledger', async () => {
    const client = await connect();
    try {
      expect(await walletsOutOfBalance(client)).toEqual([]);
    } finally {
      await client.end();
    }
  });
});
