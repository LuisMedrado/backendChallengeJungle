import { Counter, Gauge, Histogram, Registry } from 'prom-client';
import type { Channel, DuplicateType, LockConflictType, Metrics, RetrySource } from '../../application/ports';

export interface OutboxSnapshot {
  pending: number;
  oldestOccurredAt: Date | null;
}

// implementação das métricas em Prometheus. registry próprio por instância, não o global do prom-client,
// pra várias apps no msm processo não brigarem pelo msm nome de métrica
export class PrometheusMetrics implements Metrics {
  readonly registry = new Registry();

  private readonly transactions = new Counter({
    name: 'wagering_transactions_total',
    help: 'transações decididas, por canal de entrada, kind e status final',
    labelNames: ['channel', 'kind', 'status'],
    registers: [this.registry],
  });

  private readonly duplicates = new Counter({
    name: 'wagering_duplicates_total',
    help: 'duplicatas reconhecidas: replay pela idempotency key ou msm mensagem de novo pela inbox',
    labelNames: ['type'],
    registers: [this.registry],
  });

  private readonly retries = new Counter({
    name: 'wagering_retries_total',
    help: 'novas tentativas agendadas, por origem',
    labelNames: ['source'],
    registers: [this.registry],
  });

  private readonly deadLetters = new Counter({
    name: 'wagering_dead_letters_total',
    help: 'mensagens que o consumer mandou direto pra DLQ por erro permanente',
    labelNames: ['reason'],
    registers: [this.registry],
  });

  private readonly lockConflicts = new Counter({
    name: 'wagering_lock_conflicts_total',
    help: 'disputas de concorrência: lock timeout, deadlock, version que mudou e corrida de idempotência',
    labelNames: ['type'],
    registers: [this.registry],
  });

  private readonly processing = new Histogram({
    name: 'wagering_processing_duration_seconds',
    help: 'tempo do processamento de uma operação, do recebimento ao commit',
    labelNames: ['channel', 'outcome'],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [this.registry],
  });

  private readonly reconciliationDivergences = new Counter({
    name: 'wagering_reconciliation_divergences_total',
    help: 'reconciliações em que o saldo da wallet não bateu com o ledger',
    registers: [this.registry],
  });

  transactionDecided(channel: Channel, kind: string, status: string): void {
    this.transactions.inc({ channel, kind, status });
  }

  duplicateDetected(type: DuplicateType): void {
    this.duplicates.inc({ type });
  }

  retryScheduled(source: RetrySource): void {
    this.retries.inc({ source });
  }

  deadLettered(reason: string): void {
    this.deadLetters.inc({ reason });
  }

  lockConflict(type: LockConflictType): void {
    this.lockConflicts.inc({ type });
  }

  processingObserved(channel: Channel, outcome: string, seconds: number): void {
    this.processing.observe({ channel, outcome }, seconds);
  }

  reconciliationDivergence(): void {
    this.reconciliationDivergences.inc();
  }

  // valores lidos na hora do scrape em vez de contador incrementado, assim não desviam do estado real
  registerOutbox(read: () => Promise<OutboxSnapshot>): void {
    new Gauge({
      name: 'wagering_outbox_pending',
      help: 'eventos gravados na outbox e ainda não publicados',
      registers: [this.registry],
      async collect() {
        this.set((await read()).pending);
      },
    });
    new Gauge({
      name: 'wagering_outbox_lag_seconds',
      help: 'há quanto tempo o evento pendente mais antigo espera pra ser publicado',
      registers: [this.registry],
      async collect() {
        const { oldestOccurredAt } = await read();
        this.set(oldestOccurredAt ? Math.max(0, (Date.now() - oldestOccurredAt.getTime()) / 1000) : 0);
      },
    });
  }

  registerDeadLetterDepth(read: () => Promise<number>): void {
    new Gauge({
      name: 'wagering_dlq_depth',
      help: 'mensagens paradas na DLQ, inclusive as que chegaram pelo redrive do SQS',
      registers: [this.registry],
      async collect() {
        this.set(await read());
      },
    });
  }
}
