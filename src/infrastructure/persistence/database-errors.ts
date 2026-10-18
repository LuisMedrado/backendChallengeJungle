import {
  ConnectionException,
  DeadlockException,
  LockWaitTimeoutException,
  UniqueConstraintViolationException,
} from '@mikro-orm/core';
import { DuplicateKeyError, TransientInfrastructureError, type TransientReason } from '../../application/errors';

// códigos do postgres e do node que valem retry: serialização, deadlock, lock timeout,
// banco reiniciando, conexão caiu, muitas conexões
const TRANSIENT_CODES: ReadonlySet<string> = new Set([
  '40001',
  '40P01',
  '55P03',
  '57P01',
  '57P02',
  '57P03',
  '08000',
  '08001',
  '08003',
  '08006',
  '53300',
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
]);

// traduz erro do driver pra erro da aplicação, o resto passa intacto
export function translateDatabaseError(error: unknown): unknown {
  if (error instanceof UniqueConstraintViolationException) {
    return new DuplicateKeyError((error as { constraint?: string }).constraint);
  }
  const code = (error as { code?: unknown } | null)?.code;
  if (
    error instanceof ConnectionException ||
    error instanceof DeadlockException ||
    error instanceof LockWaitTimeoutException ||
    (typeof code === 'string' && TRANSIENT_CODES.has(code))
  ) {
    return new TransientInfrastructureError('banco indisponível ou em contenção, tenta de novo', transientReason(error, code));
  }
  return error;
}

function transientReason(error: unknown, code: unknown): TransientReason {
  if (error instanceof LockWaitTimeoutException || code === '55P03') return 'lock_timeout';
  if (error instanceof DeadlockException || code === '40P01') return 'deadlock';
  if (code === '40001') return 'serialization';
  return 'unavailable';
}
