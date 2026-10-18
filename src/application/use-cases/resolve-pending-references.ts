import { FailureCode } from '../../domain/wagering/failure-code';
import { WagerSettlement } from '../../domain/wagering/wager-settlement';
import { WagerTransactionStatus } from '../../domain/wagering/wager-transaction';
import { outboxMessagesFor } from '../events';
import { type Clock, type IdGenerator, type Metrics, NOOP_METRICS, type UnitOfWork } from '../ports';

export interface ResolvePendingReferencesResult {
  /** referência chegou e a operação foi aplicada */
  processed: number;
  /** referência chegou inválida ou esgotou as tentativas */
  rejected: number;
  /** referência ainda não chegou, nova tentativa agendada */
  rescheduled: number;
  failures: { transactionId: string; reason: string }[];
}

type Outcome = 'processed' | 'rejected' | 'rescheduled' | 'skipped';

// reprocessa transações que chegaram antes da referência delas, como pede o enunciado na seção 7.1
// cada transação vai numa transação SQL própria, travando a wallet primeiro:
// msm ordem de lock do http e da fila, então não tem deadlock, e dois workers na msm transação ficam em fila
export class ResolvePendingReferences {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly batchSize: number,
    private readonly metrics: Metrics = NOOP_METRICS,
  ) {}

  async execute(): Promise<ResolvePendingReferencesResult> {
    const result: ResolvePendingReferencesResult = { processed: 0, rejected: 0, rescheduled: 0, failures: [] };
    const due = await this.uow.read((scope) =>
      scope.transactions.findDuePendingReferences(this.clock.now(), this.batchSize),
    );

    for (const transactionId of due) {
      try {
        const outcome = await this.resolve(transactionId);
        if (outcome !== 'skipped') result[outcome] += 1;
        if (outcome === 'rescheduled') this.metrics.retryScheduled('pending_reference');
      } catch (error) {
        // uma transação com problema não trava as outras do lote, ela continua vencida e volta no próximo ciclo
        result.failures.push({ transactionId, reason: error instanceof Error ? error.message : String(error) });
      }
    }
    return result;
  }

  private resolve(transactionId: string): Promise<Outcome> {
    return this.uow.transactional(async (scope) => {
      const candidate = await scope.transactions.findById(transactionId);
      if (!candidate) return 'skipped';

      const wallet = await scope.wallets.lockById(candidate.walletId);
      // relê depois do lock: outro worker pode ter resolvido ela enquanto essa esperava
      const transaction = await scope.transactions.findById(transactionId);
      const now = this.clock.now();
      if (
        !wallet ||
        !transaction ||
        transaction.status !== WagerTransactionStatus.PendingReference ||
        !transaction.referenceExternalTransactionId ||
        (transaction.nextReferenceCheckAt && transaction.nextReferenceCheckAt.getTime() > now.getTime())
      ) {
        return 'skipped';
      }

      const reference = await scope.transactions.findByExternalId(
        transaction.providerId,
        transaction.referenceExternalTransactionId,
      );
      const referenceReady = reference !== undefined && reference.isTerminal();

      let ledgerEntry;
      if (!referenceReady && transaction.hasExhaustedReferenceAttempts()) {
        // limite de tentativas acabou: rejeita de vez e publica o evento
        transaction.reject(FailureCode.ReferenceNotFound, wallet.balance);
      } else {
        const referenceAlreadyReversed =
          reference && transaction.isReversal()
            ? await scope.transactions.hasProcessedReversal(reference.id, transaction.kind)
            : false;
        const versionBefore = wallet.version;
        const settlement = WagerSettlement.settle({
          transaction,
          wallet,
          reference,
          referenceAlreadyReversed,
          ledgerEntryId: this.ids.next(),
          now,
        });
        if (settlement.status === WagerTransactionStatus.Processed && settlement.ledgerEntry) {
          ledgerEntry = settlement.ledgerEntry;
          await scope.wallets.saveBalance(wallet, versionBefore);
          await scope.ledger.insert(ledgerEntry);
        }
      }

      await scope.transactions.update(transaction);

      // nova tentativa só atualiza a linha, o evento de pendente já saiu na primeira vez
      if (transaction.status === WagerTransactionStatus.PendingReference) return 'rescheduled';

      // decisão final saindo pelo worker conta como canal próprio
      this.metrics.transactionDecided('worker', transaction.kind, transaction.status);
      const trace = { correlationId: transaction.id, causationId: transaction.id };
      await scope.outbox.add(outboxMessagesFor(transaction, wallet, ledgerEntry, trace, this.ids, this.clock));
      // essa também pode ser referência de outra que estava esperando, tipo um ROLLBACK de REFUND
      await scope.transactions.wakeUpDependents(transaction.providerId, transaction.externalTransactionId, now);
      return transaction.status === WagerTransactionStatus.Processed ? 'processed' : 'rejected';
    });
  }
}
