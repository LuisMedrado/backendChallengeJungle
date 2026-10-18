import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import type { SQSClient } from '@aws-sdk/client-sqs';
import type { Client } from 'pg';
import type { Clock, EventPublisher } from '../../src/application/ports';
import { PublishOutboxBatch } from '../../src/application/use-cases/publish-outbox-batch';
import type { OutboxMessage } from '../../src/domain/messaging/outbox-message';
import { createSqsClient } from '../../src/infrastructure/messaging/sqs-client';
import { SqsEventPublisher } from '../../src/infrastructure/messaging/sqs-event-publisher';
import { createOrmConfig } from '../../src/infrastructure/persistence/mikro-orm.config';
import { PostgresUnitOfWork } from '../../src/infrastructure/persistence/postgres-unit-of-work';
import { OutboxPublisherWorker } from '../../src/infrastructure/workers/outbox-publisher.worker';
import { connect, insert, migrate, testDatabaseUrl } from './support/database';
import { eventsQueueUrl, purgeQueue, receiveAll } from './support/sqs';

// relógio controlado pelo teste, pra provar o backoff sem esperar de verdade
class TestClock implements Clock {
  constructor(private current = new Date('2026-10-17T12:00:00.000Z')) {}
  now(): Date {
    return this.current;
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

// espião que publica de verdade no SQS e só anota o que publicou
class RecordingPublisher implements EventPublisher {
  readonly published: string[] = [];

  constructor(
    private readonly inner: EventPublisher,
    private readonly afterPublish?: () => void,
  ) {}

  async publish(message: OutboxMessage): Promise<void> {
    await this.inner.publish(message);
    this.published.push(message.id);
    this.afterPublish?.();
  }
}

// cada instância tem seu próprio pool de conexões, como processos separados
async function startInstance() {
  const orm = await MikroORM.init(createOrmConfig(testDatabaseUrl()));
  return { uow: new PostgresUnitOfWork(orm, 5_000), close: () => orm.close(true) };
}

let db: Client;
let sqs: SQSClient;
let instanceA: Awaited<ReturnType<typeof startInstance>>;
let instanceB: Awaited<ReturnType<typeof startInstance>>;
let clock: TestClock;

beforeAll(async () => {
  await migrate('down');
  await migrate('up');
  db = await connect();
  sqs = createSqsClient();
  instanceA = await startInstance();
  instanceB = await startInstance();
});

afterAll(async () => {
  await instanceA?.close();
  await instanceB?.close();
  await db?.end();
  sqs?.destroy();
});

beforeEach(async () => {
  await db.query('TRUNCATE outbox_messages');
  await purgeQueue(sqs, eventsQueueUrl());
  clock = new TestClock();
});

const realPublisher = () => new SqsEventPublisher(sqs, eventsQueueUrl());

async function seedEvents(count: number, overrides: Record<string, unknown> = {}): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const id = crypto.randomUUID();
    const aggregateId = crypto.randomUUID();
    await insert(db, 'outbox_messages', {
      id,
      aggregate_id: aggregateId,
      event_type: 'WagerTransactionProcessed',
      payload: JSON.stringify({ eventId: id, eventType: 'WagerTransactionProcessed', aggregateId, data: { i } }),
      occurred_at: clock.now(),
      ...overrides,
    });
    ids.push(id);
  }
  return ids;
}

async function pending(): Promise<{ id: string; attempts: number; next_attempt_at: Date | null }[]> {
  const { rows } = await db.query(
    'SELECT id, attempts, next_attempt_at FROM outbox_messages WHERE published_at IS NULL ORDER BY sequence',
  );
  return rows;
}

describe('PublishOutboxBatch', () => {
  it('publica os eventos pendentes no SQS e marca como publicados', async () => {
    const ids = await seedEvents(3);
    const publish = new PublishOutboxBatch(instanceA.uow, realPublisher(), clock, 50);

    expect(await publish.execute()).toEqual({ published: 3, failed: 0 });
    expect(await pending()).toEqual([]);

    const messages = await receiveAll(sqs, eventsQueueUrl());
    expect(messages.map((m) => JSON.parse(m.Body!).eventId).sort()).toEqual([...ids].sort());
    // dedup id = eventId, group = aggregateId
    for (const message of messages) {
      const body = JSON.parse(message.Body!);
      expect(message.Attributes?.MessageDeduplicationId).toBe(body.eventId);
      expect(message.Attributes?.MessageGroupId).toBe(body.aggregateId);
    }
  });

  it('rodar de novo não republica o que já foi publicado', async () => {
    await seedEvents(2);
    const spy = new RecordingPublisher(realPublisher());
    const publish = new PublishOutboxBatch(instanceA.uow, spy, clock, 50);

    await publish.execute();
    expect(await publish.execute()).toEqual({ published: 0, failed: 0 });
    expect(spy.published).toHaveLength(2);
  });

  it('respeita o lote: publica no máximo batchSize por execução', async () => {
    await seedEvents(5);
    const publish = new PublishOutboxBatch(instanceA.uow, realPublisher(), clock, 2);
    expect(await publish.execute()).toEqual({ published: 2, failed: 0 });
    expect(await pending()).toHaveLength(3);
  });

  it('evento com next_attempt_at no futuro espera o backoff', async () => {
    const later = new Date(clock.now().getTime() + 60_000);
    await seedEvents(1, { attempts: 1, next_attempt_at: later });
    const publish = new PublishOutboxBatch(instanceA.uow, realPublisher(), clock, 50);

    expect(await publish.execute()).toEqual({ published: 0, failed: 0 });
    clock.advance(60_000);
    expect(await publish.execute()).toEqual({ published: 1, failed: 0 });
  });

  it('falha no SQS agenda nova tentativa com backoff, para o lote e não perde nenhum evento', async () => {
    const [first, second] = await seedEvents(2);
    const brokenQueue = new SqsEventPublisher(sqs, eventsQueueUrl().replace('wager-events', 'fila-que-nao-existe'));
    const failing = new PublishOutboxBatch(instanceA.uow, brokenQueue, clock, 50);

    // broker fora: para no primeiro erro em vez de esperar o timeout de cada evento do lote
    expect(await failing.execute()).toEqual({ published: 0, failed: 1 });
    const afterFailure = await pending();
    expect(afterFailure).toHaveLength(2);
    expect(afterFailure.find((row) => row.id === first)).toMatchObject({ attempts: 1 });
    expect(new Date(afterFailure.find((row) => row.id === first)!.next_attempt_at!).getTime()).toBeGreaterThan(
      clock.now().getTime(),
    );
    // o resto do lote nem foi tentado, segue sem tentativa contada
    expect(afterFailure.find((row) => row.id === second)).toMatchObject({ attempts: 0, next_attempt_at: null });

    // com o broker de volta, o que não foi tentado sai na hora e o que falhou espera o backoff
    const healthy = new PublishOutboxBatch(instanceA.uow, realPublisher(), clock, 50);
    expect(await healthy.execute()).toEqual({ published: 1, failed: 0 });
    expect((await pending()).map((row) => row.id)).toEqual([first!]);
    clock.advance(1_000);
    expect(await healthy.execute()).toEqual({ published: 1, failed: 0 });
    expect(await pending()).toEqual([]);
  });

  it('dois publishers concorrentes em instâncias separadas publicam cada evento uma vez só', async () => {
    const ids = await seedEvents(60);
    const spyA = new RecordingPublisher(realPublisher());
    const spyB = new RecordingPublisher(realPublisher());
    const publishA = new PublishOutboxBatch(instanceA.uow, spyA, clock, 7);
    const publishB = new PublishOutboxBatch(instanceB.uow, spyB, clock, 7);

    // cada instância roda lotes até não sobrar nada
    const drain = async (publish: PublishOutboxBatch) => {
      while ((await publish.execute()).published > 0) {}
    };
    await Promise.all([drain(publishA), drain(publishB)]);

    const all = [...spyA.published, ...spyB.published];
    expect(all).toHaveLength(60);
    expect(new Set(all).size).toBe(60);
    expect([...all].sort()).toEqual([...ids].sort());
    // as duas trabalharam de fato, não foi uma só fazendo tudo
    expect(spyA.published.length).toBeGreaterThan(0);
    expect(spyB.published.length).toBeGreaterThan(0);
    expect(await pending()).toEqual([]);
  });

  it('instância morre depois de publicar e antes do commit: outra publica de novo com o msm eventId', async () => {
    const [eventId] = await seedEvents(1);
    const dying = new RecordingPublisher(realPublisher(), () => {
      throw new Error('processo morreu antes do commit');
    });
    const publishA = new PublishOutboxBatch(instanceA.uow, dying, clock, 50);

    await expect(publishA.execute()).rejects.toThrow('processo morreu antes do commit');
    // rollback: o evento continua pendente, sem tentativa contada
    expect(await pending()).toMatchObject([{ id: eventId, attempts: 0 }]);

    const survivor = new RecordingPublisher(realPublisher());
    const publishB = new PublishOutboxBatch(instanceB.uow, survivor, clock, 50);
    expect(await publishB.execute()).toEqual({ published: 1, failed: 0 });

    // publicado duas vezes com o msm id: o consumidor deduplica pelo eventId
    expect(dying.published).toEqual([eventId!]);
    expect(survivor.published).toEqual([eventId!]);
    expect(await pending()).toEqual([]);
  });
});

describe('OutboxPublisherWorker', () => {
  it('publica em loop sozinho e para limpo no stop', async () => {
    await seedEvents(3);
    const worker = new OutboxPublisherWorker(
      new PublishOutboxBatch(instanceA.uow, realPublisher(), clock, 50),
      20,
    );

    worker.start();
    const deadline = Date.now() + 5_000;
    while ((await pending()).length > 0 && Date.now() < deadline) await Bun.sleep(20);
    await worker.stop();

    expect(await pending()).toEqual([]);
    expect(worker.isRunning()).toBe(false);
  });

  it('erro inesperado num lote não derruba o loop', async () => {
    await seedEvents(1);
    let calls = 0;
    const flaky = new RecordingPublisher(realPublisher(), () => {
      calls += 1;
      if (calls === 1) throw new Error('erro inesperado');
    });
    const worker = new OutboxPublisherWorker(new PublishOutboxBatch(instanceA.uow, flaky, clock, 50), 20);

    worker.start();
    const deadline = Date.now() + 5_000;
    while ((await pending()).length > 0 && Date.now() < deadline) await Bun.sleep(20);
    await worker.stop();

    expect(await pending()).toEqual([]);
    expect(calls).toBeGreaterThanOrEqual(2);
  });
});
