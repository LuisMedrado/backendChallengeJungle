import { describe, expect, it } from 'bun:test';
import { type WagerPayloadFields, computePayloadHash } from '../../../src/application/idempotency/payload-hash';

const payload = (overrides: Partial<WagerPayloadFields> = {}): WagerPayloadFields => ({
  providerId: 'provider-a',
  externalTransactionId: 'transaction-123',
  playerId: 'player-1',
  walletId: 'wallet-1',
  roundId: 'round-987',
  gameId: 'tigrao',
  kind: 'BET',
  money: { amount: '25.00', currency: 'BRL' },
  ...overrides,
});

describe('payloadHash', () => {
  it('é determinístico e independe da ordem das chaves', () => {
    const a = payload();
    const reordered = Object.fromEntries(Object.entries(a).reverse()) as unknown as WagerPayloadFields;
    expect(Object.keys(reordered)).not.toEqual(Object.keys(a));
    expect(computePayloadHash(a)).toBe(computePayloadHash(reordered));
    expect(computePayloadHash(a)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('payload divergente gera hash diferente', () => {
    expect(computePayloadHash(payload())).not.toBe(computePayloadHash(payload({ money: { amount: '25.01', currency: 'BRL' } })));
    expect(computePayloadHash(payload())).not.toBe(computePayloadHash(payload({ kind: 'WIN' })));
  });

  it('ignora campos fora do subconjunto de negócio, tipo header e metadados de transporte)', () => {
    const withTransport = { ...payload(), idempotencyKey: 'provider-a:transaction-123', messageId: 'msg-1' };
    expect(computePayloadHash(withTransport)).toBe(computePayloadHash(payload()));
  });

  it('referência vazia equivale a ausente', () => {
    expect(computePayloadHash(payload({ referenceExternalTransactionId: '' }))).toBe(computePayloadHash(payload()));
  });
});
