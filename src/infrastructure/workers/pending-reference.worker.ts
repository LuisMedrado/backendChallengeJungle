import { Logger } from '@nestjs/common';
import type { ResolvePendingReferences } from '../../application/use-cases/resolve-pending-references';
import { PollingWorker } from './polling-worker';

const logger = new Logger('PendingReferenceWorker');

// reprocessa as transações que chegaram antes da referência, conforme o backoff de cada uma vence
export class PendingReferenceWorker extends PollingWorker {
  constructor(resolver: ResolvePendingReferences, pollIntervalMs: number) {
    super(
      PendingReferenceWorker.name,
      async () => {
        const result = await resolver.execute();
        // falha de uma transação fica registrada e ela volta no próximo ciclo, as outras seguem
        for (const failure of result.failures) {
          logger.warn(`transação ${failure.transactionId} não resolvida: ${failure.reason}`);
        }
        return result.processed + result.rejected + result.rescheduled;
      },
      pollIntervalMs,
    );
  }
}
