import { Controller, Get, Inject, Res } from '@nestjs/common';
import type { MikroORM } from '@mikro-orm/postgresql';
import { MIKRO_ORM } from '../../infrastructure/tokens';

interface StatusResponse {
  status(code: number): unknown;
}

// sem autenticação, como o enunciado pede
@Controller('health')
export class HealthController {
  constructor(@Inject(MIKRO_ORM) private readonly orm: MikroORM) {}

  /** liveness */
  @Get('live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  // readiness, confere se o banco responde. o sqs entra junto com o consumer
  @Get('ready')
  async ready(@Res({ passthrough: true }) response: StatusResponse) {
    const postgres = await this.orm.em
      .fork()
      .execute('SELECT 1')
      .then(() => 'up' as const)
      .catch(() => 'down' as const);
    const ok = postgres === 'up';
    response.status(ok ? 200 : 503);
    return { status: ok ? 'ok' : 'error', checks: { postgres } };
  }
}
