import { Inject, Logger, Module, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import type { SQSClient } from '@aws-sdk/client-sqs';
import type { Clock, IdGenerator, Metrics, UnitOfWork } from './application/ports';
import { CreateWallet } from './application/use-cases/create-wallet';
import { ProcessWagerTransaction } from './application/use-cases/process-wager-transaction';
import { ResolvePendingReferences } from './application/use-cases/resolve-pending-references';
import {
  GetWagerTransaction,
  GetWallet,
  GetWalletLedger,
  ReconcileWallet,
  type ReconciliationReport,
} from './application/use-cases/queries';
import { booleanEnv, positiveIntEnv, requireEnv } from './infrastructure/config';
import { PersistenceModule } from './infrastructure/persistence/persistence.module';
import { MessagingModule } from './infrastructure/messaging/messaging.module';
import { ObservabilityModule } from './infrastructure/observability/observability.module';
import { SystemModule } from './infrastructure/system.module';
import {
  CLOCK,
  ID_GENERATOR,
  METRICS,
  PENDING_REFERENCE_WORKER,
  SQS_CLIENT,
  SQS_CONSUMER,
  UNIT_OF_WORK,
} from './infrastructure/tokens';
import { PendingReferenceWorker } from './infrastructure/workers/pending-reference.worker';
import { HealthController } from './interfaces/http/health.controller';
import { MetricsController } from './interfaces/http/metrics.controller';
import { WageringController } from './interfaces/http/wagering.controller';
import { WalletsController } from './interfaces/http/wallets.controller';
import { SqsWagerConsumer } from './interfaces/sqs/sqs-wager-consumer';
import { WagerMessageHandler } from './interfaces/sqs/wager-message.handler';

// use cases são classes puras, sem decorator do nest, então entram por factory
const writeDeps = [UNIT_OF_WORK, CLOCK, ID_GENERATOR];
const instrumentedDeps = [...writeDeps, METRICS];

const reconciliationLogger = new Logger('Reconciliation');

// nome do consumer na inbox, se um dia tiver outro consumer da msm fila ele usa outro nome
const WAGER_CONSUMER_NAME = 'wager-transactions-consumer';

@Module({
  imports: [SystemModule, PersistenceModule, MessagingModule, ObservabilityModule],
  controllers: [HealthController, MetricsController, WalletsController, WageringController],
  providers: [
    {
      provide: CreateWallet,
      useFactory: (uow: UnitOfWork, clock: Clock, ids: IdGenerator) => new CreateWallet(uow, clock, ids),
      inject: writeDeps,
    },
    {
      provide: ProcessWagerTransaction,
      useFactory: (uow: UnitOfWork, clock: Clock, ids: IdGenerator, metrics: Metrics) =>
        new ProcessWagerTransaction(uow, clock, ids, metrics),
      inject: instrumentedDeps,
    },
    { provide: GetWallet, useFactory: (uow: UnitOfWork) => new GetWallet(uow), inject: [UNIT_OF_WORK] },
    { provide: GetWalletLedger, useFactory: (uow: UnitOfWork) => new GetWalletLedger(uow), inject: [UNIT_OF_WORK] },
    { provide: GetWagerTransaction, useFactory: (uow: UnitOfWork) => new GetWagerTransaction(uow), inject: [UNIT_OF_WORK] },
    {
      provide: ReconcileWallet,
      useFactory: (uow: UnitOfWork, metrics: Metrics) =>
        new ReconcileWallet(uow, {
          // divergência é logada e contada na métrica, nunca corrigida
          onDivergence: (report: ReconciliationReport) => {
            metrics.reconciliationDivergence();
            reconciliationLogger.warn({
              msg: 'saldo da wallet não bate com o ledger',
              walletId: report.walletId,
              checkedEntries: report.checkedEntries,
            });
          },
        }),
      inject: [UNIT_OF_WORK, METRICS],
    },
    {
      provide: SQS_CONSUMER,
      useFactory: (sqs: SQSClient, processWager: ProcessWagerTransaction, metrics: Metrics) =>
        new SqsWagerConsumer(
          sqs,
          new WagerMessageHandler(processWager, WAGER_CONSUMER_NAME),
          {
            queueUrl: requireEnv('SQS_QUEUE_URL'),
            deadLetterQueueUrl: requireEnv('SQS_DLQ_URL'),
            waitTimeSeconds: positiveIntEnv('SQS_WAIT_TIME_SECONDS', 20),
            maxMessages: 10,
            retryBaseDelaySeconds: positiveIntEnv('SQS_RETRY_BASE_DELAY_SECONDS', 1),
            retryMaxDelaySeconds: positiveIntEnv('SQS_RETRY_MAX_DELAY_SECONDS', 60),
          },
          metrics,
        ),
      inject: [SQS_CLIENT, ProcessWagerTransaction, METRICS],
    },
    {
      provide: PENDING_REFERENCE_WORKER,
      useFactory: (uow: UnitOfWork, clock: Clock, ids: IdGenerator, metrics: Metrics) =>
        new PendingReferenceWorker(
          new ResolvePendingReferences(uow, clock, ids, positiveIntEnv('PENDING_REFERENCE_BATCH_SIZE', 50), metrics),
          positiveIntEnv('PENDING_REFERENCE_POLL_INTERVAL_MS', 1_000),
        ),
      inject: instrumentedDeps,
    },
  ],
})
export class AppModule implements OnApplicationBootstrap, OnModuleDestroy {
  constructor(
    @Inject(SQS_CONSUMER) private readonly consumer: SqsWagerConsumer,
    @Inject(PENDING_REFERENCE_WORKER) private readonly pendingReferenceWorker: PendingReferenceWorker,
  ) {}

  // toda instância consome, o lock por wallet e a inbox seguram a concorrência entre elas
  onApplicationBootstrap(): void {
    if (booleanEnv('SQS_CONSUMER_ENABLED', true)) this.consumer.start();
    // toda instância roda, a transação de cada pendente trava a wallet e quem chegar depois pula
    if (booleanEnv('PENDING_REFERENCE_WORKER_ENABLED', true)) this.pendingReferenceWorker.start();
  }

  // no SIGTERM o nest chama isso antes de fechar o pool do banco:
  // para de receber, termina a mensagem em andamento e devolve as outras pra fila
  async onModuleDestroy(): Promise<void> {
    await Promise.all([this.consumer.stop(), this.pendingReferenceWorker.stop()]);
  }
}
