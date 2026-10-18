import { Logger } from '@nestjs/common';
import type { PublishOutboxBatch } from '../../application/use-cases/publish-outbox-batch';

// roda lotes da outbox em loop. lote cheio emenda o próximo direto, lote vazio espera o intervalo
// stop espera o lote atual terminar, então o shutdown não corta uma publicação no meio
export class OutboxPublisherWorker {
  private readonly logger = new Logger(OutboxPublisherWorker.name);
  private running = false;
  private loop: Promise<void> | undefined;
  private wakeUp: (() => void) | undefined;

  constructor(
    private readonly publishBatch: PublishOutboxBatch,
    private readonly pollIntervalMs: number,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.wakeUp?.();
    await this.loop;
  }

  isRunning(): boolean {
    return this.running;
  }

  private async run(): Promise<void> {
    while (this.running) {
      let published = 0;
      try {
        published = (await this.publishBatch.execute()).published;
      } catch (error) {
        // erro inesperado não derruba o loop, o lote volta por rollback e tenta de novo depois
        this.logger.error(`falha no lote da outbox: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (published === 0 && this.running) await this.sleep();
    }
  }

  // espera o intervalo, mas acorda na hora se pedirem stop
  private sleep(): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, this.pollIntervalMs);
      this.wakeUp = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }
}
