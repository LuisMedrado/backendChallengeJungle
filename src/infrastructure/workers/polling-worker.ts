import { Logger } from '@nestjs/common';

// roda uma tarefa em loop. se a tarefa fez trabalho emenda o próximo ciclo direto, se não fez espera o intervalo
// stop espera o ciclo atual terminar, então o shutdown não corta nada no meio
export class PollingWorker {
  protected readonly logger: Logger;
  private running = false;
  private loop: Promise<void> | undefined;
  private wakeUp: (() => void) | undefined;

  constructor(
    name: string,
    /** devolve quanto trabalho fez no ciclo, zero faz o worker esperar o intervalo */
    private readonly task: () => Promise<number>,
    private readonly pollIntervalMs: number,
  ) {
    this.logger = new Logger(name);
  }

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
      let done = 0;
      try {
        done = await this.task();
      } catch (error) {
        // erro inesperado não derruba o loop, o ciclo seguinte tenta de novo
        this.logger.error(`falha no ciclo: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (done === 0 && this.running) await this.sleep();
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
