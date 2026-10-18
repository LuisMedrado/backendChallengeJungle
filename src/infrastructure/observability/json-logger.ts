import type { LoggerService } from '@nestjs/common';

type Level = 'error' | 'warn' | 'info' | 'debug' | 'verbose' | 'fatal';

// chaves que nunca saem no log, nem aninhadas: valor de dinheiro, payload inteiro e credencial.
// o código já evita logar isso, aqui é a segunda barreira
const SENSITIVE_KEYS: ReadonlySet<string> = new Set([
  'amount',
  'balance',
  'balancebefore',
  'balanceafter',
  'initialbalance',
  'money',
  'difference',
  'payload',
  'body',
  'authorization',
  'password',
]);

const REDACTED = '[redacted]';

// logger do nest que escreve uma linha JSON por entrada, pronta pra ir pra qualquer agregador de log
// mensagem em objeto vira campos estruturados, tipo correlationId, messageId, transactionId, walletId e providerId
export class JsonLogger implements LoggerService {
  constructor(private readonly write: (line: string) => void = (line) => process.stdout.write(`${line}\n`)) {}

  log(message: unknown, ...params: unknown[]): void {
    this.emit('info', message, params);
  }

  error(message: unknown, ...params: unknown[]): void {
    this.emit('error', message, params);
  }

  warn(message: unknown, ...params: unknown[]): void {
    this.emit('warn', message, params);
  }

  debug(message: unknown, ...params: unknown[]): void {
    this.emit('debug', message, params);
  }

  verbose(message: unknown, ...params: unknown[]): void {
    this.emit('verbose', message, params);
  }

  fatal(message: unknown, ...params: unknown[]): void {
    this.emit('fatal', message, params);
  }

  private emit(level: Level, message: unknown, params: unknown[]): void {
    // o nest manda o contexto como último parâmetro e, no error, o stack antes dele
    const context = typeof params.at(-1) === 'string' ? (params.at(-1) as string) : undefined;
    const stack = level === 'error' && params.length >= 2 && typeof params[0] === 'string' ? params[0] : undefined;

    const fields =
      message !== null && typeof message === 'object' && !(message instanceof Error)
        ? (redact(message) as Record<string, unknown>)
        : { msg: message instanceof Error ? message.message : String(message) };

    const entry = {
      time: new Date().toISOString(),
      level,
      ...(context ? { context } : {}),
      ...fields,
      ...(stack ? { stack } : {}),
    };
    this.write(JSON.stringify(entry));
  }
}

function redact(value: unknown, depth = 0): unknown {
  if (depth > 5 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      SENSITIVE_KEYS.has(key.toLowerCase()) ? REDACTED : redact(item, depth + 1),
    ]),
  );
}
