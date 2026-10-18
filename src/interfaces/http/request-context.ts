import { InvalidRequestError } from '../../application/errors';
import type { EventTrace } from '../../application/events';
import type { IdGenerator } from '../../application/ports';

const MAX_HEADER_LENGTH = 255;

// header é a fonte da verdade da idempotência, sem ele não processa
export function requireIdempotencyKey(header: string | undefined): string {
  const key = header?.trim();
  if (!key) throw new InvalidRequestError('header Idempotency-Key é obrigatório');
  if (key.length > MAX_HEADER_LENGTH) throw new InvalidRequestError('Idempotency-Key muito longa');
  return key;
}

// usa o correlation id de quem chamou, se não tiver gera um
export function traceFrom(correlationHeader: string | undefined, ids: IdGenerator): EventTrace {
  const correlationId = correlationHeader?.trim();
  return {
    correlationId: correlationId && correlationId.length <= MAX_HEADER_LENGTH ? correlationId : ids.next(),
  };
}
