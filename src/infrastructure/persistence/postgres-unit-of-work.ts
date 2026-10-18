import type { MikroORM } from '@mikro-orm/postgresql';
import type { TransactionScope, UnitOfWork } from '../../application/ports';
import { translateDatabaseError } from './database-errors';
import { createScope } from './sql-repositories';

// cada chamada usa um fork do EntityManager, então requisições concorrentes não dividem contexto
export class PostgresUnitOfWork implements UnitOfWork {
  constructor(
    private readonly orm: MikroORM,
    private readonly lockTimeoutMs: number,
  ) {}

  async transactional<T>(work: (scope: TransactionScope) => Promise<T>): Promise<T> {
    try {
      // erro dentro do callback faz rollback de tudo, commit só no final
      return await this.orm.em.fork().transactional(async (em) => {
        // quem espera lock demais desiste com erro 55P03, que vira 503, em vez de prender conexão do pool
        // enquanto uma wallet travada segura as requisições dela. SET LOCAL vale só pra essa transação
        await em.execute(`SET LOCAL lock_timeout = '${this.lockTimeoutMs}ms'`);
        return work(createScope(em));
      });
    } catch (error) {
      throw translateDatabaseError(error);
    }
  }

  async read<T>(work: (scope: TransactionScope) => Promise<T>): Promise<T> {
    try {
      return await work(createScope(this.orm.em.fork()));
    } catch (error) {
      throw translateDatabaseError(error);
    }
  }
}
