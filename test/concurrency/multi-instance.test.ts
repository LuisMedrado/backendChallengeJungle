import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { GetQueueAttributesCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { Client } from 'pg';
import { createSqsClient } from '../../src/infrastructure/messaging/sqs-client';
import { connect, migrate, walletsOutOfBalance } from '../integration/support/database';
import {
  deadLetterQueueUrl,
  eventsQueueUrl,
  purgeQueue,
  receiveAll,
  sendToQueue,
  wagerQueueUrl,
} from '../integration/support/sqs';
import {
  Cluster,
  freePorts,
  type Instance,
  killInstance,
  request,
  startCluster,
  startInstance,
  waitFor,
} from './support/instances';

// três processos de verdade da aplicação, cada um com seu pool de conexões, consumer e workers
const INSTANCES = 3;

let cluster: Cluster;
let db: Client;
let sqs: SQSClient;

beforeAll(async () => {
  await migrate('down');
  await migrate('up');
  db = await connect();
  sqs = createSqsClient();
  for (const url of [wagerQueueUrl(), deadLetterQueueUrl(), eventsQueueUrl()]) await purgeQueue(sqs, url);
  cluster = new Cluster(await startCluster(await freePorts(INSTANCES)));
}, 60_000);

afterAll(async () => {
  await Promise.all((cluster?.instances ?? []).map((instance) => killInstance(instance).catch(() => {})));
  await db?.end();
  sqs?.destroy();
});

type Wallet = { id: string; playerId: string };
const brl = (amount: string) => ({ amount, currency: 'BRL' });

async function createWallet(amount: string, via = 0): Promise<Wallet> {
  const res = await request(cluster.at(via).baseUrl, 'POST', '/wallets', {
    playerId: crypto.randomUUID(),
    initialBalance: brl(amount),
  });
  expect(res.status).toBe(201);
  return res.body;
}

function bet(wallet: Wallet, amount: string, externalTransactionId = `tx-${crypto.randomUUID()}`) {
  return {
    providerId: 'provider-a',
    externalTransactionId,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'round-1',
    gameId: 'tigrao',
    kind: 'BET',
    money: brl(amount),
  };
}

function queueMessage(wallet: Wallet, amount: string) {
  const externalTransactionId = `tx-${crypto.randomUUID()}`;
  return {
    messageId: `msg-${crypto.randomUUID()}`,
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
    data: { ...bet(wallet, amount, externalTransactionId), idempotencyKey: `provider-a:${externalTransactionId}` },
  };
}

async function walletState(wallet: Wallet): Promise<{ balance: string; debits: number }> {
  const { rows } = await db.query<{ balance: string; debits: number }>(
    `SELECT w.balance, (SELECT count(*)::int FROM wallet_ledger_entries l WHERE l.wallet_id = w.id AND l.direction = 'DEBIT') AS debits
       FROM wallets w WHERE w.id = $1`,
    [wallet.id],
  );
  return rows[0]!;
}

async function processedBets(walletIds: string[]): Promise<number> {
  const { rows } = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM wager_transactions WHERE kind = 'BET' AND status = 'PROCESSED' AND wallet_id = ANY($1)`,
    [walletIds],
  );
  return rows[0]!.n;
}

async function queueDrained(queueUrl: string): Promise<boolean> {
  const { Attributes = {} } = await sqs.send(
    new GetQueueAttributesCommand({
      QueueUrl: queueUrl,
      AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
    }),
  );
  return Attributes.ApproximateNumberOfMessages === '0' && Attributes.ApproximateNumberOfMessagesNotVisible === '0';
}

async function unpublishedEvents(): Promise<number> {
  const { rows } = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM outbox_messages WHERE published_at IS NULL');
  return rows[0]!.n;
}

describe('três instâncias da aplicação ao msm tempo', () => {
  it('disputando o saldo da msm wallet pelo http: nenhum débito a mais, saldo nunca negativo', async () => {
    const wallet = await createWallet('100.00');
    // 30 apostas de 10.00 distribuídas entre as 3 instâncias, saldo só dá pra 10
    const results = await Promise.all(Array.from({ length: 30 }, (_, i) => cluster.submit(bet(wallet, '10.00'), i)));

    expect(results.filter((r) => r.status === 200)).toHaveLength(10);
    expect(results.filter((r) => r.status === 422)).toHaveLength(20);
    expect(results.filter((r) => r.status === 422).every((r) => r.body.failureCode === 'INSUFFICIENT_FUNDS')).toBe(true);
    expect(await walletState(wallet)).toEqual({ balance: '0.00', debits: 10 });
  }, 60_000);

  it('a msm aposta enviada 60 vezes espalhada entre as instâncias debita uma vez só', async () => {
    const wallet = await createWallet('100.00');
    const body = bet(wallet, '10.00');
    const results = await Promise.all(Array.from({ length: 60 }, (_, i) => cluster.submit(body, i)));

    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(new Set(results.map((r) => r.body.transactionId)).size).toBe(1);
    expect(results.filter((r) => r.body.idempotentReplay === false)).toHaveLength(1);
    expect(await walletState(wallet)).toEqual({ balance: '90.00', debits: 1 });
  }, 60_000);

  it('as três consumindo a msm fila: mensagem repetida e operação repetida não duplicam efeito', async () => {
    const wallets = await Promise.all(Array.from({ length: 5 }, (_, i) => createWallet('100.00', i)));
    const messages = wallets.flatMap((wallet) => Array.from({ length: 10 }, () => queueMessage(wallet, '1.00')));

    for (const message of messages) await sendToQueue(sqs, wagerQueueUrl(), message, { groupId: message.data.walletId });
    // redelivery: as 10 primeiras de novo com o msm messageId
    for (const message of messages.slice(0, 10)) {
      await sendToQueue(sqs, wagerQueueUrl(), message, { groupId: message.data.walletId });
    }
    // msm operação em mensagem nova: outro messageId, msm idempotencyKey
    for (const message of messages.slice(10, 15)) {
      await sendToQueue(
        sqs,
        wagerQueueUrl(),
        { ...message, messageId: `msg-${crypto.randomUUID()}` },
        { groupId: message.data.walletId },
      );
    }

    await waitFor(
      async () => (await processedBets(wallets.map((w) => w.id))) === 50 && (await queueDrained(wagerQueueUrl())),
      60_000,
      'consumers processarem a fila',
    );

    for (const wallet of wallets) expect(await walletState(wallet)).toEqual({ balance: '90.00', debits: 10 });
    expect(await receiveAll(sqs, deadLetterQueueUrl())).toEqual([]);
  }, 90_000);

  it('instância morta no meio da carga e reiniciada: tudo termina aplicado exatamente uma vez', async () => {
    const wallets = await Promise.all(Array.from({ length: 10 }, (_, i) => createWallet('1000.00', i)));
    // 10 apostas por http e 10 pela fila em cada wallet
    const httpBets = wallets.flatMap((wallet) => Array.from({ length: 10 }, () => bet(wallet, '1.00')));
    const queueBets = wallets.flatMap((wallet) => Array.from({ length: 10 }, () => queueMessage(wallet, '1.00')));

    for (const message of queueBets) await sendToQueue(sqs, wagerQueueUrl(), message, { groupId: message.data.walletId });
    const httpDone = Promise.all(httpBets.map((body, i) => cluster.submit(body, i)));

    // derruba a primeira instância com trabalho em andamento: requisições, mensagens e lotes da outbox
    await waitFor(async () => (await processedBets(wallets.map((w) => w.id))) >= 40, 30_000, 'parte da carga processar');
    const victim: Instance = cluster.at(0);
    cluster.failovers = 0;
    await killInstance(victim);
    await Bun.sleep(500);
    cluster.replace(0, await startInstance(victim.port));

    const responses = await httpDone;
    expect(responses.every((r) => r.status === 200)).toBe(true);
    // prova de que a morte pegou requisição em andamento, senão o teste não provou nada
    expect(cluster.failovers).toBeGreaterThan(0);

    // mensagem que estava em voo na instância morta só volta depois do visibility timeout de 30s
    await waitFor(
      async () =>
        (await processedBets(wallets.map((w) => w.id))) === 200 &&
        (await queueDrained(wagerQueueUrl())) &&
        (await unpublishedEvents()) === 0,
      80_000,
      'sistema voltar ao estado estável',
    );

    for (const wallet of wallets) expect(await walletState(wallet)).toEqual({ balance: '980.00', debits: 20 });
    const { rows } = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM inbox_messages');
    expect(rows[0]!.n).toBeGreaterThanOrEqual(100);
    expect(await receiveAll(sqs, deadLetterQueueUrl())).toEqual([]);
    expect(await walletsOutOfBalance(db)).toEqual([]);
  }, 150_000);
});

describe('invariante final', () => {
  it('toda wallet do banco tem saldo igual ao reconstruído pelo ledger', async () => {
    expect(await walletsOutOfBalance(db)).toEqual([]);
  });
});
