import {
  Global,
  Inject,
  Module,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
  type OnModuleDestroy,
} from '@nestjs/common';
import type { SQSClient } from '@aws-sdk/client-sqs';
import type { Clock, EventPublisher, Metrics, UnitOfWork } from '../../application/ports';
import { PublishOutboxBatch } from '../../application/use-cases/publish-outbox-batch';
import { booleanEnv, positiveIntEnv, requireEnv } from '../config';
import { CLOCK, EVENT_PUBLISHER, METRICS, OUTBOX_WORKER, SQS_CLIENT, UNIT_OF_WORK } from '../tokens';
import { OutboxPublisherWorker } from '../workers/outbox-publisher.worker';
import { createSqsClient } from './sqs-client';
import { SqsEventPublisher } from './sqs-event-publisher';

const DEFAULT_POLL_INTERVAL_MS = 500;
const DEFAULT_BATCH_SIZE = 50;

@Global()
@Module({
  providers: [
    { provide: SQS_CLIENT, useFactory: () => createSqsClient() },
    {
      provide: EVENT_PUBLISHER,
      useFactory: (client: SQSClient) => new SqsEventPublisher(client, requireEnv('SQS_EVENTS_QUEUE_URL')),
      inject: [SQS_CLIENT],
    },
    {
      provide: PublishOutboxBatch,
      useFactory: (uow: UnitOfWork, publisher: EventPublisher, clock: Clock, metrics: Metrics) =>
        new PublishOutboxBatch(uow, publisher, clock, positiveIntEnv('OUTBOX_BATCH_SIZE', DEFAULT_BATCH_SIZE), metrics),
      inject: [UNIT_OF_WORK, EVENT_PUBLISHER, CLOCK, METRICS],
    },
    {
      provide: OUTBOX_WORKER,
      useFactory: (publishBatch: PublishOutboxBatch) =>
        new OutboxPublisherWorker(publishBatch, positiveIntEnv('OUTBOX_POLL_INTERVAL_MS', DEFAULT_POLL_INTERVAL_MS)),
      inject: [PublishOutboxBatch],
    },
  ],
  exports: [SQS_CLIENT],
})
export class MessagingModule implements OnApplicationBootstrap, OnModuleDestroy, OnApplicationShutdown {
  constructor(
    @Inject(OUTBOX_WORKER) private readonly worker: OutboxPublisherWorker,
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
  ) {}

  // toda instância roda o publisher, o SKIP LOCKED divide o trabalho entre elas
  onApplicationBootstrap(): void {
    if (booleanEnv('OUTBOX_PUBLISHER_ENABLED', true)) this.worker.start();
  }

  // para antes do pool do banco fechar, terminando o lote que tiver em andamento
  async onModuleDestroy(): Promise<void> {
    await this.worker.stop();
  }

  onApplicationShutdown(): void {
    this.sqs.destroy();
  }
}
