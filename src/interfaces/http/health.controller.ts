import { Controller, Get } from '@nestjs/common';

@Controller('health')
export class HealthController {
  /** liveness */
  @Get('live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

}
