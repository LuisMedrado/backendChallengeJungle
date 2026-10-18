import { Controller, Get, Inject, Res } from '@nestjs/common';
import { GetQueueAttributesCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';
import { MIKRO_ORM, SQS_CLIENT } from '../../infrastructure/tokens';

interface StatusResponse {
  status(code: number): unknown;
}

type CheckStatus = 'up' | 'down';

const CHECK_TIMEOUT_MS = 2_000;

// sem autenticação, como o enunciado pede
@Controller('health')
export class HealthController {
  constructor(
    @Inject(MIKRO_ORM) private readonly orm: MikroORM,
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
  ) {}

  /** liveness */
  @Get('live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  // readiness, confere se o banco e a fila de entrada respondem
  @Get('ready')
  async ready(@Res({ passthrough: true }) response: StatusResponse) {
    const [postgres, sqs] = await Promise.all([this.checkPostgres(), this.checkSqs()]);
    const ok = postgres === 'up' && sqs === 'up';
    response.status(ok ? 200 : 503);
    return { status: ok ? 'ok' : 'error', checks: { postgres, sqs } };
  }

  private checkPostgres(): Promise<CheckStatus> {
    return this.orm.em
      .fork()
      .execute('SELECT 1')
      .then(() => 'up' as const)
      .catch(() => 'down' as const);
  }

  private checkSqs(): Promise<CheckStatus> {
    const queueUrl = process.env.SQS_QUEUE_URL;
    if (!queueUrl) return Promise.resolve('down');
    return this.sqs
      .send(new GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: ['QueueArn'] }), {
        abortSignal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
      })
      .then(() => 'up' as const)
      .catch(() => 'down' as const);
  }
}
