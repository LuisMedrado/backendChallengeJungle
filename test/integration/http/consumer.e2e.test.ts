import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { SQSClient } from '@aws-sdk/client-sqs';
import type { Client } from 'pg';
import { createSqsClient } from '../../../src/infrastructure/messaging/sqs-client';
import { connect, migrate, walletsOutOfBalance } from '../support/database';
import { startTestApp, type TestApp } from '../support/http';
import { deadLetterQueueUrl, purgeQueue, sendToQueue, wagerQueueUrl } from '../support/sqs';

let api: TestApp;
let sqs: SQSClient;
let db: Client;

beforeAll(async () => {
  await migrate('down');
  await migrate('up');
  sqs = createSqsClient();
  db = await connect();
  await purgeQueue(sqs, wagerQueueUrl());
  await purgeQueue(sqs, deadLetterQueueUrl());
  api = await startTestApp({ sqsConsumer: true });
});

afterAll(async () => {
  await api?.close();
  await db?.end();
  sqs?.destroy();
});

describe('consumer dentro da aplicação', () => {
  it('mensagem publicada na fila é processada pelo app e o saldo aparece na api', async () => {
    const wallet = await api.post('/wallets', {
      playerId: crypto.randomUUID(),
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });
    const externalTransactionId = `tx-${crypto.randomUUID()}`;
    await sendToQueue(
      sqs,
      wagerQueueUrl(),
      {
        messageId: `msg-${crypto.randomUUID()}`,
        type: 'WagerTransactionRequested',
        occurredAt: new Date().toISOString(),
        data: {
          providerId: 'provider-a',
          externalTransactionId,
          idempotencyKey: `provider-a:${externalTransactionId}`,
          playerId: wallet.body.playerId,
          walletId: wallet.body.id,
          roundId: 'round-987',
          gameId: 'tigrao',
          kind: 'BET',
          money: { amount: '25.00', currency: 'BRL' },
        },
      },
      { groupId: wallet.body.id },
    );

    // o consumer roda em segundo plano, espera a transação aparecer pela api
    const deadline = Date.now() + 10_000;
    let found = await api.get(`/providers/provider-a/wagering/transactions/${externalTransactionId}`);
    while (found.status === 404 && Date.now() < deadline) {
      await Bun.sleep(100);
      found = await api.get(`/providers/provider-a/wagering/transactions/${externalTransactionId}`);
    }

    expect(found.status).toBe(200);
    expect(found.body.status).toBe('PROCESSED');
    expect((await api.get(`/wallets/${wallet.body.id}`)).body.balance).toEqual({ amount: '75.00', currency: 'BRL' });
  }, 15_000);

  it('fechar o app para o consumer sem pendurar o processo', async () => {
    const started = Date.now();
    await api.close();
    // long polling é cortado no stop, não espera os segundos do receive
    expect(Date.now() - started).toBeLessThan(3_000);
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
