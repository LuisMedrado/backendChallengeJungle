import { MikroORM } from '@mikro-orm/postgresql';
import { Client } from 'pg';
import { createOrmConfig } from '../../../src/infrastructure/persistence/mikro-orm.config';

export function testDatabaseUrl(): string {
  const url = process.env.DATABASE_URL_TEST;
  if (!url) throw new Error('DATABASE_URL_TEST não definida, copia o .env.example pra .env');
  return url;
}

// roda as migrations no banco de teste, down volta tudo pro zero
export async function migrate(direction: 'up' | 'down'): Promise<void> {
  const orm = await MikroORM.init(createOrmConfig(testDatabaseUrl()));
  try {
    const migrator = orm.migrator;
    if (direction === 'up') await migrator.up();
    else await migrator.down({ to: 0 });
  } finally {
    await orm.close(true);
  }
}

export async function connect(): Promise<Client> {
  const client = new Client({ connectionString: testDatabaseUrl() });
  await client.connect();
  return client;
}

// invariante final do enunciado: saldo da wallet == saldo reconstruído pelo ledger, pra todas as wallets do banco.
// devolve as que não batem, lista vazia é o esperado
export async function walletsOutOfBalance(db: Client): Promise<{ id: string; balance: string; ledger: string }[]> {
  const { rows } = await db.query<{ id: string; balance: string; ledger: string }>(
    `SELECT w.id, w.balance::text AS balance,
            COALESCE(SUM(CASE l.direction WHEN 'CREDIT' THEN l.amount ELSE -l.amount END), 0)::numeric(19,2)::text AS ledger
       FROM wallets w
       LEFT JOIN wallet_ledger_entries l ON l.wallet_id = w.id
      GROUP BY w.id, w.balance
     HAVING w.balance <> COALESCE(SUM(CASE l.direction WHEN 'CREDIT' THEN l.amount ELSE -l.amount END), 0)`,
  );
  return rows;
}

// colunas vem dos próprios testes, valores vão sempre como parâmetro
export async function insert(db: Client, table: string, row: Record<string, unknown>): Promise<void> {
  const columns = Object.keys(row);
  const placeholders = columns.map((_, i) => `$${i + 1}`);
  await db.query(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders.join(', ')})`, Object.values(row));
}
