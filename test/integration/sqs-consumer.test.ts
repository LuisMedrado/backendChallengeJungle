import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import type { SQSClient } from '@aws-sdk/client-sqs';
import type { Client } from 'pg';
import { CreateWallet } from '../../src/application/use-cases/create-wallet';
import { ProcessWagerTransaction } from '../../src/application/use-cases/process-wager-transaction';
import { createSqsClient } from '../../src/infrastructure/messaging/sqs-client';
import { createOrmConfig } from '../../src/infrastructure/persistence/mikro-orm.config';
import { PostgresUnitOfWork } from '../../src/infrastructure/persistence/postgres-unit-of-work';
import { SystemClock, UuidV7Generator } from '../../src/infrastructure/system';
import {
  type ConsumerOptions,
  type MessageHandler,
  SqsWagerConsumer,
} from '../../src/interfaces/sqs/sqs-wager-consumer';
import { WagerMessageHandler } from '../../src/interfaces/sqs/wager-message.handler';
import { connect, migrate, testDatabaseUrl } from './support/database';
import { deadLetterQueueUrl, purgeQueue, receiveAll, sendToQueue, wagerQueueUrl } from './support/sqs';

const CONSUMER_NAME = 'wager-transactions-consumer';

let db: Client;
let sqs: SQSClient;
let orm: MikroORM;
let uow: PostgresUnitOfWork;
const clock = new SystemClock();
const ids = new UuidV7Generator();
let running: SqsWagerConsumer[] = [];

beforeAll(async () => {
  await migrate('down');
  await migrate('up');
  db = await connect();
  sqs = createSqsClient();
  orm = await MikroORM.init(createOrmConfig(testDatabaseUrl()));
  // lock timeout curto pro teste de falha transitória não demorar
  uow = new PostgresUnitOfWork(orm, 300);
});

afterAll(async () => {
  await orm?.close(true);
  await db?.end();
  sqs?.destroy();
});

beforeEach(async () => {
  await purgeQueue(sqs, wagerQueueUrl());
  await purgeQueue(sqs, deadLetterQueueUrl());
});

afterEach(async () => {
  await Promise.all(running.map((consumer) => consumer.stop()));
  running = [];
});

function realHandler(): MessageHandler {
  return new WagerMessageHandler(new ProcessWagerTransaction(uow, clock, ids), CONSUMER_NAME);
}

function newConsumer(handler: MessageHandler = realHandler(), options: Partial<ConsumerOptions> = {}) {
  const consumer = new SqsWagerConsumer(sqs, handler, {
    queueUrl: wagerQueueUrl(),
    deadLetterQueueUrl: deadLetterQueueUrl(),
    waitTimeSeconds: 1,
    maxMessages: 10,
    retryBaseDelaySeconds: 1,
    retryMaxDelaySeconds: 60,
    ...options,
  });
  running.push(consumer);
  return consumer;
}

async function createWallet(amount = '100.00') {
  const wallet = await new CreateWallet(uow, clock, ids).execute({
    playerId: crypto.randomUUID(),
    initialBalance: { amount, currency: 'BRL' },
    trace: { correlationId: 'test' },
  });
  return { id: wallet.id, playerId: wallet.playerId };
}

type TestWallet = Awaited<ReturnType<typeof createWallet>>;

// formato de mensagem do enunciado
function wagerMessage(wallet: TestWallet, data: Record<string, unknown> = {}, envelope: Record<string, unknown> = {}) {
  const externalTransactionId = `tx-${crypto.randomUUID()}`;
  return {
    messageId: `msg-${crypto.randomUUID()}`,
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
    data: {
      providerId: 'provider-a',
      externalTransactionId,
      idempotencyKey: `provider-a:${externalTransactionId}`,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'round-1',
      gameId: 'tigrao',
      kind: 'BET',
      money: { amount: '10.00', currency: 'BRL' },
      ...data,
    },
    ...envelope,
  };
}

const send = (body: unknown, options: { groupId?: string; deduplicationId?: string } = {}) =>
  sendToQueue(sqs, wagerQueueUrl(), body, options);

async function balanceOf(wallet: TestWallet): Promise<string> {
  const { rows } = await db.query<{ balance: string }>('SELECT balance FROM wallets WHERE id = $1', [wallet.id]);
  return rows[0]!.balance;
}

async function debitsOf(wallet: TestWallet): Promise<number> {
  const { rows } = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM wallet_ledger_entries WHERE wallet_id = $1 AND direction = 'DEBIT'`,
    [wallet.id],
  );
  return rows[0]!.n;
}

async function inboxCount(messageId: string): Promise<number> {
  const { rows } = await db.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM inbox_messages WHERE consumer_name = $1 AND message_id = $2',
    [CONSUMER_NAME, messageId],
  );
  return rows[0]!.n;
}

async function transactionStatus(externalTransactionId: string): Promise<string | undefined> {
  const { rows } = await db.query<{ status: string }>(
    'SELECT status FROM wager_transactions WHERE external_transaction_id = $1',
    [externalTransactionId],
  );
  return rows[0]?.status;
}

// roda ciclos do consumer até a condição valer ou estourar o tempo
async function pollUntil(consumer: SqsWagerConsumer, condition: () => Promise<boolean>, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await consumer.pollOnce();
    if (await condition()) return;
  }
  throw new Error('condição não foi atingida a tempo');
}

describe('SqsWagerConsumer', () => {
  it('mensagem válida passa pelo msm use case do http, faz ack e não volta', async () => {
    const wallet = await createWallet('100.00');
    const message = wagerMessage(wallet);
    await send(message, { groupId: wallet.id });

    const consumer = newConsumer();
    await pollUntil(consumer, async () => (await transactionStatus(message.data.externalTransactionId)) !== undefined);

    expect(await transactionStatus(message.data.externalTransactionId)).toBe('PROCESSED');
    expect(await balanceOf(wallet)).toBe('90.00');
    expect(await inboxCount(message.messageId)).toBe(1);
    // ack feito: não sobrou nada na fila nem na DLQ
    expect(await receiveAll(sqs, wagerQueueUrl())).toEqual([]);
    expect(await receiveAll(sqs, deadLetterQueueUrl())).toEqual([]);
  });

  it('redelivery da msm mensagem é deduplicado pela inbox e não debita de novo', async () => {
    const wallet = await createWallet('100.00');
    const message = wagerMessage(wallet);
    // dedup ids diferentes pro SQS não descartar a cópia, quem segura é a inbox
    await send(message, { groupId: wallet.id });
    await send(message, { groupId: wallet.id });

    const consumer = newConsumer();
    for (let i = 0; i < 3; i++) await consumer.pollOnce();

    expect(await debitsOf(wallet)).toBe(1);
    expect(await inboxCount(message.messageId)).toBe(1);
    expect(await receiveAll(sqs, wagerQueueUrl())).toEqual([]);
  });

  it('mensagens diferentes com a msm idempotencyKey caem no replay e não debitam de novo', async () => {
    const wallet = await createWallet('100.00');
    const first = wagerMessage(wallet);
    const second = { ...first, messageId: `msg-${crypto.randomUUID()}` };
    await send(first, { groupId: wallet.id });
    await send(second, { groupId: wallet.id });

    const consumer = newConsumer();
    for (let i = 0; i < 3; i++) await consumer.pollOnce();

    expect(await debitsOf(wallet)).toBe(1);
    expect(await inboxCount(first.messageId)).toBe(1);
    expect(await inboxCount(second.messageId)).toBe(1);
  });

  it('rejeição de negócio é terminal: ack, transação REJECTED e nada na DLQ', async () => {
    const wallet = await createWallet('5.00');
    const message = wagerMessage(wallet, { money: { amount: '10.00', currency: 'BRL' } });
    await send(message, { groupId: wallet.id });

    const consumer = newConsumer();
    await pollUntil(consumer, async () => (await transactionStatus(message.data.externalTransactionId)) !== undefined);

    expect(await transactionStatus(message.data.externalTransactionId)).toBe('REJECTED');
    expect(await receiveAll(sqs, wagerQueueUrl())).toEqual([]);
    expect(await receiveAll(sqs, deadLetterQueueUrl())).toEqual([]);
  });

  it.each([
    ['json quebrado', () => '{ isso não é json'],
    ['type desconhecido', (w: TestWallet) => wagerMessage(w, {}, { type: 'OutraCoisa' })],
    ['amount em notação científica', (w: TestWallet) => wagerMessage(w, { money: { amount: '1e3', currency: 'BRL' } })],
    ['OPENING vindo da fila', (w: TestWallet) => wagerMessage(w, { kind: 'OPENING' })],
    ['wallet inexistente', (w: TestWallet) => wagerMessage(w, { walletId: crypto.randomUUID() })],
  ])('erro permanente (%s) vai direto pra DLQ sem efeito nenhum', async (_, build) => {
    const wallet = await createWallet('100.00');
    await send(build(wallet), { groupId: wallet.id });

    const consumer = newConsumer();
    await consumer.pollOnce();

    const dead = await receiveAll(sqs, deadLetterQueueUrl());
    expect(dead).toHaveLength(1);
    expect(await receiveAll(sqs, wagerQueueUrl())).toEqual([]);
    expect(await balanceOf(wallet)).toBe('100.00');
  });

  it('msm idempotencyKey com payload diferente é conflito permanente e vai pra DLQ', async () => {
    const wallet = await createWallet('100.00');
    const original = wagerMessage(wallet);
    const conflicting = {
      ...original,
      messageId: `msg-${crypto.randomUUID()}`,
      data: { ...original.data, money: { amount: '99.00', currency: 'BRL' } },
    };
    await send(original, { groupId: wallet.id });
    await send(conflicting, { groupId: wallet.id });

    const consumer = newConsumer();
    for (let i = 0; i < 3; i++) await consumer.pollOnce();

    expect(await debitsOf(wallet)).toBe(1);
    const dead = await receiveAll(sqs, deadLetterQueueUrl());
    expect(dead.map((m) => JSON.parse(m.Body!).messageId)).toEqual([conflicting.messageId]);
  });

  it('falha transitória não faz ack: a mensagem volta depois do backoff e processa', async () => {
    const wallet = await createWallet('100.00');
    const message = wagerMessage(wallet);
    await send(message, { groupId: wallet.id });

    // trava a wallet por fora: o use case estoura o lock timeout e vira erro transitório
    const locker = await connect();
    await locker.query('BEGIN');
    await locker.query('SELECT 1 FROM wallets WHERE id = $1 FOR UPDATE', [wallet.id]);

    const consumer = newConsumer();
    try {
      await consumer.pollOnce();
      expect(await transactionStatus(message.data.externalTransactionId)).toBeUndefined();
      expect(await inboxCount(message.messageId)).toBe(0);
    } finally {
      await locker.query('ROLLBACK');
      await locker.end();
    }

    await pollUntil(consumer, async () => (await transactionStatus(message.data.externalTransactionId)) !== undefined);
    expect(await debitsOf(wallet)).toBe(1);
    expect(await receiveAll(sqs, deadLetterQueueUrl())).toEqual([]);
  });

  it('falha transitória que não passa esgota as tentativas e o redrive manda pra DLQ', async () => {
    const wallet = await createWallet('100.00');
    const message = wagerMessage(wallet);
    await send(message, { groupId: wallet.id });

    const locker = await connect();
    await locker.query('BEGIN');
    await locker.query('SELECT 1 FROM wallets WHERE id = $1 FOR UPDATE', [wallet.id]);
    try {
      // backoff zero pra mensagem voltar na hora e esgotar as 5 tentativas rápido
      const consumer = newConsumer(realHandler(), { retryBaseDelaySeconds: 0 });
      for (let i = 0; i < 8; i++) await consumer.pollOnce();
    } finally {
      await locker.query('ROLLBACK');
      await locker.end();
    }

    const dead = await receiveAll(sqs, deadLetterQueueUrl());
    expect(dead.map((m) => JSON.parse(m.Body!).messageId)).toEqual([message.messageId]);
    expect(await debitsOf(wallet)).toBe(0);
  }, 30_000);

  it('worker morre depois do commit e antes do ack: a redelivery não duplica o débito', async () => {
    const wallet = await createWallet('100.00');
    const message = wagerMessage(wallet);
    await send(message, { groupId: wallet.id });

    // processa e commita de verdade, mas "morre" antes do consumer fazer o ack
    const real = realHandler();
    let crashed = false;
    const dying: MessageHandler = {
      handle: async (incoming) => {
        const outcome = await real.handle(incoming);
        if (!crashed) {
          crashed = true;
          throw new Error('processo morreu antes do ack');
        }
        return outcome;
      },
    };

    // 1º ciclo commita e morre sem ack, 2º recebe a redelivery e a inbox reconhece
    const consumer = newConsumer(dying, { retryBaseDelaySeconds: 0 });
    for (let i = 0; i < 3; i++) await consumer.pollOnce();

    expect(crashed).toBe(true);
    expect(await debitsOf(wallet)).toBe(1);
    expect(await balanceOf(wallet)).toBe('90.00');
    expect(await inboxCount(message.messageId)).toBe(1);
    expect(await receiveAll(sqs, wagerQueueUrl())).toEqual([]);
  }, 15_000);

  it('stop termina a mensagem em andamento e devolve a visibility das que sobraram no lote', async () => {
    const wallet = await createWallet('100.00');
    const messages = [wagerMessage(wallet), wagerMessage(wallet), wagerMessage(wallet)];
    // grupos diferentes pra virem no msm lote
    for (const message of messages) await send(message, { groupId: crypto.randomUUID() });

    const real = realHandler();
    let started = 0;
    let finished = 0;
    let firstStarted!: () => void;
    const firstStartedPromise = new Promise<void>((resolve) => (firstStarted = resolve));
    const slow: MessageHandler = {
      handle: async (incoming) => {
        started += 1;
        firstStarted();
        await Bun.sleep(300);
        const outcome = await real.handle(incoming);
        finished += 1;
        return outcome;
      },
    };

    const consumer = newConsumer(slow);
    consumer.start();
    await firstStartedPromise;
    await consumer.stop();

    // a que estava em andamento terminou, nenhuma outra começou depois do stop
    expect(started).toBe(1);
    expect(finished).toBe(1);
    expect(consumer.isRunning()).toBe(false);
    expect(await debitsOf(wallet)).toBe(1);

    // as outras voltaram pra fila na hora, sem esperar o visibility timeout de 30s
    const back = await receiveAll(sqs, wagerQueueUrl());
    expect(back).toHaveLength(2);
  }, 15_000);
});
