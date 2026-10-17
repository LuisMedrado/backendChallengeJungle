import { describe, expect, it } from 'bun:test';
import { LedgerDirection } from '../../../src/domain/ledger/wallet-ledger-entry';
import {
  CurrencyMismatchError,
  InsufficientBalanceError,
  InvalidMoneyError,
} from '../../../src/domain/shared/errors';
import { Wallet } from '../../../src/domain/wallet/wallet';
import { NOW, balanceFromLedger, brl, nextId, openWallet, usd } from './fixtures';

const movement = (amount: string) => ({
  ledgerEntryId: nextId('entry'),
  transactionId: nextId('tx'),
  money: brl(amount),
  at: NOW,
});

describe('Wallet', () => {
  describe('open', () => {
    it('com saldo inicial: version 1 e lançamento CREDIT de abertura', () => {
      const { wallet, entries } = openWallet('1000.00');
      expect(wallet.balance.amount).toBe('1000.00');
      expect(wallet.version).toBe(1);
      expect(entries).toHaveLength(1);
      expect(entries[0]!.direction).toBe(LedgerDirection.Credit);
      expect(entries[0]!.balanceBefore.amount).toBe('0.00');
      expect(entries[0]!.balanceAfter.amount).toBe('1000.00');
    });

    it('com saldo zero: version 1 e nenhum lançamento', () => {
      const { wallet, entries } = openWallet('0.00');
      expect(wallet.version).toBe(1);
      expect(entries).toHaveLength(0);
    });

    it('rejeita saldo inicial negativo', () => {
      expect(() =>
        Wallet.open({
          id: 'w',
          playerId: 'p',
          initialBalance: brl('0.00').subtract(brl('1.00')),
          openingTransactionId: 't',
          openingLedgerEntryId: 'e',
          at: NOW,
        }),
      ).toThrow(InvalidMoneyError);
    });
  });

  describe('debit', () => {
    it('debita, incrementa version e devolve lançamento consistente', () => {
      const { wallet } = openWallet('100.00');
      const entry = wallet.debit(movement('25.00'));
      expect(wallet.balance.amount).toBe('75.00');
      expect(wallet.version).toBe(2);
      expect(entry.direction).toBe(LedgerDirection.Debit);
      expect(entry.balanceBefore.amount).toBe('100.00');
      expect(entry.balanceAfter.amount).toBe('75.00');
    });

    it('permite zerar o saldo', () => {
      const { wallet } = openWallet('80.00');
      wallet.debit(movement('80.00'));
      expect(wallet.balance.isZero()).toBe(true);
    });

    it('saldo insuficiente lança e não altera saldo nem version', () => {
      const { wallet } = openWallet('100.00');
      expect(() => wallet.debit(movement('100.01'))).toThrow(InsufficientBalanceError);
      expect(wallet.balance.amount).toBe('100.00');
      expect(wallet.version).toBe(1);
    });
  });

  describe('credit', () => {
    it('credita e incrementa version', () => {
      const { wallet } = openWallet('100.00');
      wallet.credit(movement('50.00'));
      expect(wallet.balance.amount).toBe('150.00');
      expect(wallet.version).toBe(2);
    });
  });

  describe('validações', () => {
    it('moeda diferente da wallet lança CurrencyMismatchError', () => {
      const { wallet } = openWallet('100.00');
      const usdMovement = { ...movement('1.00'), money: usd('1.00') };
      expect(() => wallet.credit(usdMovement)).toThrow(CurrencyMismatchError);
      expect(() => wallet.debit(usdMovement)).toThrow(CurrencyMismatchError);
    });

    it('movimentação de valor zero é rejeitada', () => {
      const { wallet } = openWallet('100.00');
      expect(() => wallet.credit(movement('0.00'))).toThrow(InvalidMoneyError);
      expect(wallet.version).toBe(1);
    });
  });

  it('rehydrate reconstrói estado sem revalidar', () => {
    const wallet = Wallet.rehydrate({
      id: 'w',
      playerId: 'p',
      currency: 'BRL',
      balance: brl('42.00'),
      version: 7,
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(wallet.version).toBe(7);
    expect(wallet.balance.amount).toBe('42.00');
  });

  it('saldo == saldo reconstruído pelo ledger', () => {
    const { wallet, entries } = openWallet('100.00');
    entries.push(wallet.debit(movement('30.00')));
    entries.push(wallet.credit(movement('12.50')));
    entries.push(wallet.debit(movement('82.50')));
    expect(balanceFromLedger(entries).equals(wallet.balance)).toBe(true);
    expect(wallet.balance.amount).toBe('0.00');
    expect(wallet.version).toBe(4);
  });
});
