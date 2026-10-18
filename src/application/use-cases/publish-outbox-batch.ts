import { EventPublishError } from '../errors';
import type { Clock, EventPublisher, UnitOfWork } from '../ports';

export interface PublishOutboxResult {
  published: number;
  failed: number;
}

// publica um lote da outbox dentro de uma transação que segura o lock das linhas até o commit
// - outra instância rodando junto pula as linhas travadas, então ninguém publica o msm evento ao msm tempo
// - se o processo morre no meio, o rollback destrava as linhas e outra instância publica
// - publicou mas não commitou: o evento sai de novo com o msm eventId e o consumidor deduplica
export class PublishOutboxBatch {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly publisher: EventPublisher,
    private readonly clock: Clock,
    private readonly batchSize: number,
  ) {}

  execute(): Promise<PublishOutboxResult> {
    return this.uow.transactional(async (scope) => {
      const now = this.clock.now();
      const messages = await scope.outbox.claimDue(now, this.batchSize);
      const result: PublishOutboxResult = { published: 0, failed: 0 };

      for (const message of messages) {
        try {
          await this.publisher.publish(message);
          message.markPublished(this.clock.now());
          await scope.outbox.save(message);
          result.published += 1;
        } catch (error) {
          // só falha do broker vira retry, o resto sobe e derruba o lote inteiro com rollback
          if (!(error instanceof EventPublishError)) throw error;
          message.scheduleRetry(now);
          await scope.outbox.save(message);
          result.failed += 1;
          // broker fora: para aqui em vez de esperar o timeout de cada evento segurando o lock do lote.
          // os que não foram tentados voltam pra fila sem tentativa contada quando a transação commita
          break;
        }
      }
      return result;
    });
  }
}
