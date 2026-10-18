import { SQSClient } from '@aws-sdk/client-sqs';

// credenciais vêm do ambiente pelo próprio sdk, endpoint só existe no localstack
export function createSqsClient(): SQSClient {
  const endpoint = process.env.AWS_ENDPOINT_URL;
  return new SQSClient({
    region: process.env.AWS_REGION ?? 'us-east-1',
    ...(endpoint ? { endpoint } : {}),
    // sem retry interno do sdk, quem decide retry é a outbox com backoff próprio
    maxAttempts: 1,
  });
}
