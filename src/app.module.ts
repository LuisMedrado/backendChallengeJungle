import { Logger, Module } from '@nestjs/common';
import type { Clock, IdGenerator, UnitOfWork } from './application/ports';
import { CreateWallet } from './application/use-cases/create-wallet';
import { ProcessWagerTransaction } from './application/use-cases/process-wager-transaction';
import {
  GetWagerTransaction,
  GetWallet,
  GetWalletLedger,
  ReconcileWallet,
  type ReconciliationReport,
} from './application/use-cases/queries';
import { PersistenceModule } from './infrastructure/persistence/persistence.module';
import { MessagingModule } from './infrastructure/messaging/messaging.module';
import { SystemModule } from './infrastructure/system.module';
import { CLOCK, ID_GENERATOR, UNIT_OF_WORK } from './infrastructure/tokens';
import { HealthController } from './interfaces/http/health.controller';
import { WageringController } from './interfaces/http/wagering.controller';
import { WalletsController } from './interfaces/http/wallets.controller';

// use cases são classes puras, sem decorator do nest, então entram por factory
const writeDeps = [UNIT_OF_WORK, CLOCK, ID_GENERATOR];

const reconciliationLogger = new Logger('Reconciliation');

@Module({
  imports: [SystemModule, PersistenceModule, MessagingModule],
  controllers: [HealthController, WalletsController, WageringController],
  providers: [
    {
      provide: CreateWallet,
      useFactory: (uow: UnitOfWork, clock: Clock, ids: IdGenerator) => new CreateWallet(uow, clock, ids),
      inject: writeDeps,
    },
    {
      provide: ProcessWagerTransaction,
      useFactory: (uow: UnitOfWork, clock: Clock, ids: IdGenerator) => new ProcessWagerTransaction(uow, clock, ids),
      inject: writeDeps,
    },
    { provide: GetWallet, useFactory: (uow: UnitOfWork) => new GetWallet(uow), inject: [UNIT_OF_WORK] },
    { provide: GetWalletLedger, useFactory: (uow: UnitOfWork) => new GetWalletLedger(uow), inject: [UNIT_OF_WORK] },
    { provide: GetWagerTransaction, useFactory: (uow: UnitOfWork) => new GetWagerTransaction(uow), inject: [UNIT_OF_WORK] },
    {
      provide: ReconcileWallet,
      useFactory: (uow: UnitOfWork) =>
        new ReconcileWallet(uow, {
          // divergência é logada e não corrigida. métrica entra na fase de observabilidade
          onDivergence: (report: ReconciliationReport) =>
            reconciliationLogger.warn(
              `divergência na wallet ${report.walletId}: diferença ${report.difference.toString()} em ${report.checkedEntries} lançamentos`,
            ),
        }),
      inject: [UNIT_OF_WORK],
    },
  ],
})
export class AppModule {}
