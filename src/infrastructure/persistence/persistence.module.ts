import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import { positiveIntEnv, requireEnv } from '../config';
import { MIKRO_ORM, UNIT_OF_WORK } from '../tokens';
import { createOrmConfig } from './mikro-orm.config';
import { PostgresUnitOfWork } from './postgres-unit-of-work';

const DEFAULT_LOCK_TIMEOUT_MS = 5_000;

@Global()
@Module({
  providers: [
    {
      provide: MIKRO_ORM,
      useFactory: () => MikroORM.init(createOrmConfig(requireEnv('DATABASE_URL'))),
    },
    {
      provide: UNIT_OF_WORK,
      // tem que ser inteiro positivo pq o valor vai interpolado no SET LOCAL
      useFactory: (orm: MikroORM) =>
        new PostgresUnitOfWork(orm, positiveIntEnv('DB_LOCK_TIMEOUT_MS', DEFAULT_LOCK_TIMEOUT_MS)),
      inject: [MIKRO_ORM],
    },
  ],
  exports: [MIKRO_ORM, UNIT_OF_WORK],
})
export class PersistenceModule implements OnApplicationShutdown {
  constructor(@Inject(MIKRO_ORM) private readonly orm: MikroORM) {}

  // fecha o pool no shutdown, depois dos workers pararem no onModuleDestroy
  async onApplicationShutdown(): Promise<void> {
    await this.orm.close(true);
  }
}
