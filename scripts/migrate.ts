import { MikroORM } from '@mikro-orm/postgresql';
import { createOrmConfig } from '../src/infrastructure/persistence/mikro-orm.config';

// uso em bun scripts/migrate.ts, pra setar up ou down
// down volta só a última migration, pra voltar tudo tem que rodar bun scripts/migrate.ts down --all
async function main(): Promise<void> {
  const [direction, flag] = process.argv.slice(2);
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL não definida, copia o .env.example pra .env');
  if (direction !== 'up' && direction !== 'down') throw new Error('uso: bun scripts/migrate.ts up | down [--all]');

  const orm = await MikroORM.init(createOrmConfig(url));
  try {
    const migrator = orm.migrator;
    const executed =
      direction === 'up' ? await migrator.up() : await migrator.down(flag === '--all' ? { to: 0 } : undefined);
    console.log(`${direction}: ${executed.map((m) => m.name).join(', ') || 'nada a executar'}`);
  } finally {
    await orm.close(true);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
