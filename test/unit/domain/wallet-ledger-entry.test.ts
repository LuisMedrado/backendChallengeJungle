import { describe, expect, it } from 'bun:test';
import {
  type CreateLedgerEntryProps,
  LedgerDirection,
  WalletLedgerEntry,
} from '../../../src/domain/ledger/wallet-ledger-entry';
import { CurrencyMismatchError, InvalidLedgerEntryError } from '../../../src/domain/shared/errors';
import { NOW, brl, usd } from './fixtures';

const debit = (overrides: Partial<CreateLedgerEntryProps> = {}): WalletLedgerEntry =>
  WalletLedgerEntry.create({
    id: 'entry-1',
    walletId: 'wallet-1',
    transactionId: 'tx-1',
    direction: LedgerDirection.Debit,
    money: brl('25.00'),
    balanceBefore: brl('100.00'),
    balanceAfter: brl('75.00'),
    createdAt: NOW,
    ...overrides,
  });

describe('WalletLedgerEntry', () => {
  it('cria débito balanceado', () => {
    expect(debit().isBalanced()).toBe(true);
  });

  it('cria crédito balanceado', () => {
    const entry = debit({ direction: LedgerDirection.Credit, balanceAfter: brl('125.00') });
    expect(entry.isBalanced()).toBe(true);
  });

  it('rejeita aritmética inconsistente', () => {
    expect(() => debit({ balanceAfter: brl('80.00') })).toThrow(InvalidLedgerEntryError);
  });

  it('rejeita valor zero', () => {
    expect(() => debit({ money: brl('0.00'), balanceAfter: brl('100.00') })).toThrow(InvalidLedgerEntryError);
  });

  it('rejeita saldo final negativo', () => {
    expect(() =>
      debit({ money: brl('150.00'), balanceAfter: brl('100.00').subtract(brl('150.00')) }),
    ).toThrow(InvalidLedgerEntryError);
  });

  it('rejeita moedas misturadas', () => {
    expect(() => debit({ money: usd('25.00') })).toThrow(CurrencyMismatchError);
  });

  it('é imutável em runtime', () => {
    const entry = debit();
    expect(Object.isFrozen(entry)).toBe(true);
    expect(() => {
      (entry as unknown as { balanceAfter: unknown }).balanceAfter = brl('1.00');
    }).toThrow(TypeError);
  });

  it('rehydrate não revalida', () => {
    const entry = WalletLedgerEntry.rehydrate({
      id: 'entry-1',
      walletId: 'wallet-1',
      transactionId: 'tx-1',
      direction: LedgerDirection.Debit,
      money: brl('25.00'),
      balanceBefore: brl('100.00'),
      balanceAfter: brl('1.00'),
      createdAt: NOW,
    });
    expect(entry.isBalanced()).toBe(false);
  });
});
