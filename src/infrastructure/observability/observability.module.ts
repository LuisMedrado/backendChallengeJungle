import { Global, Module } from '@nestjs/common';
import { GetQueueAttributesCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';
import { requireEnv } from '../config';
import { METRICS, MIKRO_ORM, SQS_CLIENT } from '../tokens';
import { PrometheusMetrics } from './prometheus-metrics';

@Global()
@Module({
  providers: [
    {
      provide: METRICS,
      useFactory: (orm: MikroORM, sqs: SQSClient) => {
        const metrics = new PrometheusMetrics();

        metrics.registerOutbox(async () => {
          const rows = await orm.em
            .fork()
            .execute<{ pending: number; oldest: Date | string | null }[]>(
              `SELECT count(*)::int AS pending, min(occurred_at) AS oldest
                 FROM outbox_messages WHERE published_at IS NULL`,
            );
          const oldest = rows[0]?.oldest ?? null;
          return { pending: rows[0]?.pending ?? 0, oldestOccurredAt: oldest === null ? null : new Date(oldest) };
        });

        metrics.registerDeadLetterDepth(async () => {
          const { Attributes = {} } = await sqs.send(
            new GetQueueAttributesCommand({
              QueueUrl: requireEnv('SQS_DLQ_URL'),
              AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
            }),
          );
          return Number(Attributes.ApproximateNumberOfMessages ?? 0) + Number(Attributes.ApproximateNumberOfMessagesNotVisible ?? 0);
        });

        return metrics;
      },
      inject: [MIKRO_ORM, SQS_CLIENT],
    },
  ],
  exports: [METRICS],
})
export class ObservabilityModule {}
