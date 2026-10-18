import {
  DeleteMessageCommand,
  type Message,
  PurgeQueueCommand,
  ReceiveMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';

export function eventsQueueUrl(): string {
  const url = process.env.SQS_EVENTS_QUEUE_URL;
  if (!url) throw new Error('SQS_EVENTS_QUEUE_URL não definida, copia o .env.example pra .env');
  return url;
}

export async function purgeQueue(client: SQSClient, queueUrl: string): Promise<void> {
  await client.send(new PurgeQueueCommand({ QueueUrl: queueUrl }));
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
