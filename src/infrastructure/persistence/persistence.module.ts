import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import { MIKRO_ORM, UNIT_OF_WORK } from '../tokens';
import { createOrmConfig } from './mikro-orm.config';
import { PostgresUnitOfWork } from './postgres-unit-of-work';

const DEFAULT_LOCK_TIMEOUT_MS = 5_000;

// tem que ser inteiro positivo, senão volta pro padrão, pq o valor vai interpolado no SET LOCAL
function lockTimeoutMs(): number {
  const value = Number(process.env.DB_LOCK_TIMEOUT_MS);
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_LOCK_TIMEOUT_MS;
}

@Global()
@Module({
  providers: [
    {
      provide: MIKRO_ORM,
      useFactory: async () => {
        const url = process.env.DATABASE_URL;
        if (!url) throw new Error('DATABASE_URL não definida, copia o .env.example pra .env');
        return MikroORM.init(createOrmConfig(url));
      },
    },
    {
      provide: UNIT_OF_WORK,
      useFactory: (orm: MikroORM) => new PostgresUnitOfWork(orm, lockTimeoutMs()),
      inject: [MIKRO_ORM],
    },
  ],
  exports: [MIKRO_ORM, UNIT_OF_WORK],
})
export class PersistenceModule implements OnApplicationShutdown {
  constructor(@Inject(MIKRO_ORM) private readonly orm: MikroORM) {}

  // fecha o pool no shutdown, senão o processo fica pendurado
  async onApplicationShutdown(): Promise<void> {
    await this.orm.close(true);
  }
}
