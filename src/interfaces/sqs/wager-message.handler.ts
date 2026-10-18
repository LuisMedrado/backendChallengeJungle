import { createHash } from 'node:crypto';
import { Logger } from '@nestjs/common';
import {
  ConcurrentModificationError,
  IdempotencyConflictError,
  InvalidRequestError,
  TransientInfrastructureError,
  WalletNotFoundError,
} from '../../application/errors';
import type { ProcessWagerTransaction } from '../../application/use-cases/process-wager-transaction';
import { CurrencyMismatchError, InvalidMoneyError, InvalidWagerTransactionError } from '../../domain/shared/errors';
import type { HandleOutcome, IncomingMessage, MessageHandler } from './sqs-wager-consumer';
import { InvalidMessageError, parseWagerMessage } from './wager-message';

// erros em que tentar de novo dá o msm resultado: vão direto pra DLQ
const PERMANENT_ERRORS = [
  InvalidMessageError,
  InvalidMoneyError,
  InvalidWagerTransactionError,
  InvalidRequestError,
  CurrencyMismatchError,
  WalletNotFoundError,
  IdempotencyConflictError,
];

// erros que podem passar sozinhos: a mensagem volta pra fila com backoff
const TRANSIENT_ERRORS = [TransientInfrastructureError, ConcurrentModificationError];

// traduz uma mensagem da fila pro msm use case do http e decide o que o consumer faz com ela
// regra de negócio que rejeita a aposta não é erro: a transação foi gravada como REJECTED e a mensagem é ack
export class WagerMessageHandler implements MessageHandler {
  private readonly logger = new Logger(WagerMessageHandler.name);

  constructor(
    private readonly processWager: ProcessWagerTransaction,
    private readonly consumerName: string,
  ) {}

  async handle({ body }: IncomingMessage): Promise<HandleOutcome> {
    try {
      const message = await parseWagerMessage(body);
      const { idempotencyKey, ...data } = message.data;

      const result = await this.processWager.executeFromQueue(
        { ...data, idempotencyKey, trace: { correlationId: message.messageId, causationId: message.messageId } },
        {
          consumerName: this.consumerName,
          messageId: message.messageId,
          payloadHash: createHash('sha256').update(body, 'utf8').digest('hex'),
        },
      );

      if ('duplicateMessage' in result) {
        if (result.payloadMismatch) {
          this.logger.warn(`mensagem ${message.messageId} repetida com conteúdo diferente, mantido o processamento original`);
        }
        return { action: 'ack', detail: 'mensagem já processada' };
      }
      return { action: 'ack', detail: `transação ${result.transaction.id} ${result.transaction.status}` };
    } catch (error) {
      if (PERMANENT_ERRORS.some((type) => error instanceof type)) {
        return { action: 'dead-letter', detail: describe(error) };
      }
      if (TRANSIENT_ERRORS.some((type) => error instanceof type)) {
        return { action: 'retry', detail: describe(error) };
      }
      // erro inesperado sobe, o consumer trata como retry e o limite de tentativas leva pra DLQ
      throw error;
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
