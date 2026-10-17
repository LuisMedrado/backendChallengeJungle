import type { MigrationObject } from '@mikro-orm/core';
import { Migration20261017120000InitialSchema } from './Migration20261017120000InitialSchema';

// ordem de execução das migrations
export const migrationsList: MigrationObject[] = [
  { name: 'Migration20261017120000InitialSchema', class: Migration20261017120000InitialSchema },
];
