import { createHash } from 'node:crypto';
import type { MoneyProps } from '../../domain/money/money';

// campos de negócio que entram no hash. header Idempotency-Key e metadados de transporte
// (messageId, type, occurredAt) ficam de fora, aí a msm operação por HTTP ou SQS gera o msm hash
export interface WagerPayloadFields {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
}

// SHA-256 (hex) do JSON canônico dos campos acima
// JSON canônico = chaves ordenadas recursivamente, sem espaços e sem campos undefined
// referência vazia conta como ausente
export function computePayloadHash(fields: WagerPayloadFields): string {
  const subset: WagerPayloadFields = {
    providerId: fields.providerId,
    externalTransactionId: fields.externalTransactionId,
    playerId: fields.playerId,
    walletId: fields.walletId,
    roundId: fields.roundId,
    gameId: fields.gameId,
    kind: fields.kind,
    money: { amount: fields.money.amount, currency: fields.money.currency },
    referenceExternalTransactionId: fields.referenceExternalTransactionId || undefined,
  };
  return createHash('sha256').update(canonicalJson(subset), 'utf8').digest('hex');
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, sortKeys(v)]),
    );
  }
  return value;
}
