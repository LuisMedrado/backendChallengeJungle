import type { PublishOutboxBatch } from '../../application/use-cases/publish-outbox-batch';
import { PollingWorker } from './polling-worker';

// roda lotes da outbox em loop. lote cheio emenda o próximo direto, lote vazio espera o intervalo
// se o lote falhar inteiro ele volta por rollback e tenta de novo no próximo ciclo
export class OutboxPublisherWorker extends PollingWorker {
  constructor(publishBatch: PublishOutboxBatch, pollIntervalMs: number) {
    super(OutboxPublisherWorker.name, async () => (await publishBatch.execute()).published, pollIntervalMs);
  }
}
