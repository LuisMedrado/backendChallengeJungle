import { Global, Module } from '@nestjs/common';
import { SystemClock, UuidV7Generator } from './system';
import { CLOCK, ID_GENERATOR } from './tokens';

// relógio e gerador de id compartilhados por todos os módulos
@Global()
@Module({
  providers: [
    { provide: CLOCK, useClass: SystemClock },
    { provide: ID_GENERATOR, useClass: UuidV7Generator },
  ],
  exports: [CLOCK, ID_GENERATOR],
})
export class SystemModule {}
