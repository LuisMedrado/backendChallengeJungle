import { Module } from '@nestjs/common';
import { HealthController } from './interfaces/http/health.controller';

@Module({
  controllers: [HealthController],
})
export class AppModule {}
