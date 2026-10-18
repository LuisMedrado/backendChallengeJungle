import { SendMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { EventPublishError } from '../../application/errors';
import type { EventPublisher } from '../../application/ports';
import type { OutboxMessage } from '../../domain/messaging/outbox-message';

const PUBLISH_TIMEOUT_MS = 5_000;

// publica o envelope do evento numa fila FIFO
// group por aggregate mantém a ordem dos eventos da msm wallet
// dedup pelo eventId faz o SQS descartar a republicação dentro da janela dele, fora dela o consumidor deduplica
export class SqsEventPublisher implements EventPublisher {
  constructor(
    private readonly client: SQSClient,
    private readonly queueUrl: string,
  ) {}

  async publish(message: OutboxMessage): Promise<void> {
    try {
      await this.client.send(
        new SendMessageCommand({
          QueueUrl: this.queueUrl,
          MessageBody: JSON.stringify(message.payload),
          MessageGroupId: message.aggregateId,
          MessageDeduplicationId: message.id,
          MessageAttributes: { eventType: { DataType: 'String', StringValue: message.eventType } },
        }),
        // timeout pra uma chamada lenta não segurar a transação do lote
        { abortSignal: AbortSignal.timeout(PUBLISH_TIMEOUT_MS) },
      );
    } catch (error) {
      throw new EventPublishError(
        `falha ao publicar evento ${message.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
