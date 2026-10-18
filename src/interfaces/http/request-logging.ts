import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';

interface RequestLike {
  method: string;
  originalUrl?: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body?: Record<string, unknown>;
}

interface ResponseLike {
  statusCode: number;
  locals: Record<string, unknown>;
  setHeader(name: string, value: string): void;
  json(body: unknown): unknown;
  on(event: 'finish', listener: () => void): void;
}

const CORRELATION_HEADER = 'x-correlation-id';
const MAX_CORRELATION_LENGTH = 255;
const logger = new Logger('Http');

// correlationId de quem chamou ou um novo, devolvido na resposta e lido pelos controllers pelo msm header.
// no fim de cada requisição sai uma linha de log só com ids, status e duração, nunca valor de dinheiro
export function requestLogging(req: RequestLike, res: ResponseLike, next: () => void): void {
  const started = performance.now();
  const received = req.headers[CORRELATION_HEADER];
  const correlationId =
    typeof received === 'string' && received.trim() && received.length <= MAX_CORRELATION_LENGTH
      ? received.trim()
      : randomUUID();
  req.headers[CORRELATION_HEADER] = correlationId;
  res.setHeader(CORRELATION_HEADER, correlationId);

  // guarda o corpo da resposta só pra tirar o id da transação ou da wallet dele
  const json = res.json.bind(res);
  res.json = (body: unknown) => {
    res.locals.responseBody = body;
    return json(body);
  };

  res.on('finish', () => {
    const path = (req.originalUrl ?? req.url).split('?')[0] ?? '';
    const responseBody = (res.locals.responseBody ?? {}) as Record<string, unknown>;
    const fields = {
      msg: 'http request',
      method: req.method,
      path,
      status: res.statusCode,
      durationMs: Math.round((performance.now() - started) * 100) / 100,
      correlationId,
      walletId: stringField(req.body?.walletId) ?? walletIdFromPath(path) ?? (path === '/wallets' ? stringField(responseBody.id) : undefined),
      providerId: stringField(req.body?.providerId) ?? providerIdFromPath(path),
      transactionId: stringField(responseBody.transactionId),
    };
    if (res.statusCode >= 500) logger.error(fields);
    else if (res.statusCode >= 400) logger.warn(fields);
    else logger.log(fields);
  });

  next();
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function walletIdFromPath(path: string): string | undefined {
  return /^\/wallets\/([^/]+)/.exec(path)?.[1];
}

function providerIdFromPath(path: string): string | undefined {
  return /^\/providers\/([^/]+)/.exec(path)?.[1];
}
