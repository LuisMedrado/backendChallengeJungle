import { Migrator } from '@mikro-orm/migrations';
import { defineConfig, type Options } from '@mikro-orm/postgresql';
import { migrationsList } from '../../../migrations';

export function createOrmConfig(clientUrl: string): Options {
  return defineConfig({
    clientUrl,
    // entidades entram na fase 3, por enquanto só migrations
    entities: [],
    discovery: { warnWhenNoEntities: false },
    extensions: [Migrator],
    migrations: {
      // lista explícita em vez de glob no disco, funciona igual no bun e no node
      migrationsList,
      transactional: true,
      // snapshot só serve pra gerar migration automática, aqui o SQL é escrito à mão
      snapshot: false,
      allOrNothing: true,
    },
  });
}
