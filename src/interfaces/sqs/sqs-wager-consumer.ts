import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  type Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { Logger } from '@nestjs/common';
import { type Metrics, NOOP_METRICS } from '../../application/ports';

export interface IncomingMessage {
  body: string;
}

/** ids da operação pra ir no log, sem valor nenhum de dinheiro */
export interface MessageContext {
  messageId?: string;
  correlationId?: string;
  transactionId?: string;
  walletId?: string;
  providerId?: string;
}

export type HandleOutcome =
  | { action: 'ack'; detail: string; context?: MessageContext }
  | { action: 'retry'; detail: string; context?: MessageContext }
  | { action: 'dead-letter'; detail: string; reason: string; context?: MessageContext };

export interface MessageHandler {
  handle(message: IncomingMessage): Promise<HandleOutcome>;
}

export interface ConsumerOptions {
  queueUrl: string;
  deadLetterQueueUrl: string;
  /** long polling, quanto tempo o receive espera mensagem chegar */
  waitTimeSeconds: number;
  maxMessages: number;
  /** backoff do retry, dobra a cada recebimento da msm mensagem */
  retryBaseDelaySeconds: number;
  retryMaxDelaySeconds: number;
}

// consome a fila de entrada:
// - ack só depois que o handler voltou, ou seja, depois do commit
// - erro transitório não faz ack, a mensagem volta com backoff e o redrive leva pra DLQ depois do limite
// - erro permanente vai direto pra DLQ
// - no stop termina a mensagem em andamento e devolve as que sobraram no lote
export class SqsWagerConsumer {
  private readonly logger = new Logger(SqsWagerConsumer.name);
  private running = false;
  private stopping = false;
  private loop: Promise<void> | undefined;
  private receiving: AbortController | undefined;

  constructor(
    private readonly sqs: SQSClient,
    private readonly handler: MessageHandler,
    private readonly options: ConsumerOptions,
    private readonly metrics: Metrics = NOOP_METRICS,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.stopping = false;
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.running = false;
    // corta o long polling na hora em vez de esperar os segundos dele
    this.receiving?.abort();
    await this.loop;
  }

  isRunning(): boolean {
    return this.running;
  }

  /** um ciclo de receive e processamento, devolve quantas mensagens foram processadas */
  async pollOnce(): Promise<number> {
    this.receiving = new AbortController();
    let messages: Message[];
    try {
      const response = await this.sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: this.options.queueUrl,
          MaxNumberOfMessages: this.options.maxMessages,
          WaitTimeSeconds: this.options.waitTimeSeconds,
          MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId'],
        }),
        { abortSignal: this.receiving.signal },
      );
      messages = response.Messages ?? [];
    } catch (error) {
      if (this.receiving.signal.aborted) return 0;
      throw error;
    }
    return this.processBatch(messages);
  }

  private async run(): Promise<void> {
    while (this.running) {
      try {
        await this.pollOnce();
      } catch (error) {
        if (!this.running) break;
        this.logger.error({ msg: 'falha ao ler a fila', error: describe(error) });
        await Bun.sleep(1_000);
      }
    }
  }

  private async processBatch(messages: Message[]): Promise<number> {
    // grupo com falha no lote: as próximas do msm grupo não passam na frente dela
    const blockedGroups = new Set<string>();
    let processed = 0;

    for (const message of messages) {
      const group = message.Attributes?.MessageGroupId ?? '';
      if (this.stopping || blockedGroups.has(group)) {
        await this.release(message);
        continue;
      }

      const outcome = await this.handleSafely(message);
      await this.apply(message, outcome);
      processed += 1;
      if (outcome.action === 'retry') blockedGroups.add(group);
    }
    return processed;
  }

  private async handleSafely(message: Message): Promise<HandleOutcome> {
    try {
      return await this.handler.handle({ body: message.Body ?? '' });
    } catch (error) {
      this.logger.error({ msg: 'erro inesperado ao processar mensagem', sqsMessageId: message.MessageId, error: describe(error) });
      return { action: 'retry', detail: 'erro inesperado' };
    }
  }

  private async apply(message: Message, outcome: HandleOutcome): Promise<void> {
    // log estruturado com os ids, o detalhe nunca carrega valor de dinheiro
    const fields = { sqsMessageId: message.MessageId, outcome: outcome.action, detail: outcome.detail, ...outcome.context };
    try {
      switch (outcome.action) {
        case 'ack':
          await this.delete(message);
          this.logger.log({ msg: 'mensagem processada', ...fields });
          break;
        case 'dead-letter':
          await this.sendToDeadLetter(message, outcome.detail);
          await this.delete(message);
          this.metrics.deadLettered(outcome.reason);
          this.logger.warn({ msg: 'mensagem enviada pra DLQ', reason: outcome.reason, ...fields });
          break;
        case 'retry': {
          const delay = this.retryDelaySeconds(message);
          await this.changeVisibility(message, delay);
          this.metrics.retryScheduled('sqs_consumer');
          this.logger.warn({ msg: 'mensagem volta pra fila com backoff', retryInSeconds: delay, ...fields });
          break;
        }
      }
    } catch (error) {
      // falhou o ack ou a DLQ: a mensagem reaparece sozinha e a inbox segura o reprocessamento
      this.logger.error({ msg: 'falha ao finalizar mensagem', error: describe(error), ...fields });
    }
  }

  private retryDelaySeconds(message: Message): number {
    const receiveCount = Number(message.Attributes?.ApproximateReceiveCount ?? '1');
    const { retryBaseDelaySeconds, retryMaxDelaySeconds } = this.options;
    return Math.min(retryBaseDelaySeconds * 2 ** Math.max(receiveCount - 1, 0), retryMaxDelaySeconds);
  }

  private delete(message: Message): Promise<unknown> {
    return this.sqs.send(new DeleteMessageCommand({ QueueUrl: this.options.queueUrl, ReceiptHandle: message.ReceiptHandle }));
  }

  // devolve a mensagem pra fila na hora, sem esperar o visibility timeout
  private async release(message: Message): Promise<void> {
    try {
      await this.changeVisibility(message, 0);
    } catch (error) {
      this.logger.error({ msg: 'falha ao devolver mensagem pra fila', sqsMessageId: message.MessageId, error: describe(error) });
    }
  }

  private changeVisibility(message: Message, seconds: number): Promise<unknown> {
    return this.sqs.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: this.options.queueUrl,
        ReceiptHandle: message.ReceiptHandle,
        VisibilityTimeout: seconds,
      }),
    );
  }

  // DLQ FIFO precisa de grupo e dedup, o MessageId do SQS é único por mensagem recebida
  private sendToDeadLetter(message: Message, reason: string): Promise<unknown> {
    return this.sqs.send(
      new SendMessageCommand({
        QueueUrl: this.options.deadLetterQueueUrl,
        MessageBody: message.Body ?? '',
        MessageGroupId: message.Attributes?.MessageGroupId ?? 'dead-letter',
        MessageDeduplicationId: message.MessageId ?? crypto.randomUUID(),
        MessageAttributes: { reason: { DataType: 'String', StringValue: reason.slice(0, 256) } },
      }),
    );
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
