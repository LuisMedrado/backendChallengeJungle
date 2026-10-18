import {
  DeleteMessageCommand,
  type Message,
  PurgeQueueCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';

function queueUrlFromEnv(name: string): string {
  const url = process.env[name];
  if (!url) throw new Error(`${name} não definida, copia o .env.example pra .env`);
  return url;
}

export const eventsQueueUrl = (): string => queueUrlFromEnv('SQS_EVENTS_QUEUE_URL');
export const wagerQueueUrl = (): string => queueUrlFromEnv('SQS_QUEUE_URL');
export const deadLetterQueueUrl = (): string => queueUrlFromEnv('SQS_DLQ_URL');

export async function purgeQueue(client: SQSClient, queueUrl: string): Promise<void> {
  await client.send(new PurgeQueueCommand({ QueueUrl: queueUrl }));
}

export async function sendToQueue(
  client: SQSClient,
  queueUrl: string,
  body: unknown,
  options: { groupId?: string; deduplicationId?: string } = {},
): Promise<void> {
  await client.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: typeof body === 'string' ? body : JSON.stringify(body),
      MessageGroupId: options.groupId ?? 'test-group',
      MessageDeduplicationId: options.deduplicationId ?? crypto.randomUUID(),
    }),
  );
}

// lê e apaga tudo que tiver na fila, para quando duas leituras seguidas voltam vazias
export async function receiveAll(client: SQSClient, queueUrl: string): Promise<Message[]> {
  const received: Message[] = [];
  let emptyReads = 0;
  while (emptyReads < 2) {
    const { Messages = [] } = await client.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 1,
        MessageSystemAttributeNames: ['MessageGroupId', 'MessageDeduplicationId'],
      }),
    );
    emptyReads = Messages.length === 0 ? emptyReads + 1 : 0;
    for (const message of Messages) {
      received.push(message);
      await client.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle }));
    }
  }
  return received;
}
