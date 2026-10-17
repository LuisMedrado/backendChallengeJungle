import { describe, expect, it } from 'bun:test';
import { Money } from '../../../src/domain/money/money';
import { CurrencyMismatchError, InvalidMoneyError } from '../../../src/domain/shared/errors';
import { brl, usd } from './fixtures';

describe('Money', () => {
  describe('from', () => {
    it.each(['0.00', '25.00', '0.01', '1000.50', '99999999999999999.99'])('aceita "%s"', (amount) => {
      expect(brl(amount).amount).toBe(amount);
    });

    it.each([
      ['vazio', ''],
      ['sem casas decimais', '25'],
      ['uma casa decimal', '25.5'],
      ['mais de 2 casas', '25.001'],
      ['negativo', '-1.00'],
      ['notação científica', '1e3'],
      ['notação científica com decimais', '1.00e2'],
      ['NaN', 'NaN'],
      ['Infinity', 'Infinity'],
      ['zero à esquerda', '01.00'],
      ['vírgula decimal', '1,00'],
      ['espaços', ' 1.00'],
      ['sinal positivo', '+1.00'],
      ['acima de NUMERIC(19,2)', '100000000000000000.00'],
    ])('rejeita %s', (_, amount) => {
      expect(() => brl(amount)).toThrow(InvalidMoneyError);
    });

    it('rejeita amount que não é string', () => {
      expect(() => Money.from({ amount: 25 as unknown as string, currency: 'BRL' })).toThrow(InvalidMoneyError);
    });

    it.each(['', 'brl', 'BR', 'BRLL', '123'])('rejeita moeda "%s"', (currency) => {
      expect(() => Money.from({ amount: '1.00', currency })).toThrow(InvalidMoneyError);
    });
  });

  describe('calculo exato', () => {
    it('0.10 + 0.20 = 0.30 sem erro de float', () => {
      expect(brl('0.10').add(brl('0.20')).equals(brl('0.30'))).toBe(true);
    });

    it('soma valores grandes sem perda de precisão', () => {
      expect(brl('9007199254740993.01').add(brl('0.01')).amount).toBe('9007199254740993.02');
    });

    it('subtract pode produzir negativo', () => {
      const result = brl('10.00').subtract(brl('15.00'));
      expect(result.amount).toBe('-5.00');
      expect(result.isNegative()).toBe(true);
    });

    it('negate inverte o sinal e negate de zero é zero', () => {
      expect(brl('7.25').negate().amount).toBe('-7.25');
      expect(brl('0.00').negate().amount).toBe('0.00');
    });
  });

  describe('imutabilidade', () => {
    it('operações retornam nova instância e não alteram a original', () => {
      const original = brl('10.00');
      const sum = original.add(brl('5.00'));
      expect(sum).not.toBe(original);
      expect(original.amount).toBe('10.00');
    });

    it('instância é congelada', () => {
      expect(Object.isFrozen(brl('1.00'))).toBe(true);
    });
  });

  describe('moedas diferentes', () => {
    it.each([
      ['add', (a: Money, b: Money) => a.add(b)],
      ['subtract', (a: Money, b: Money) => a.subtract(b)],
      ['isLessThan', (a: Money, b: Money) => a.isLessThan(b)],
    ])('%s lança CurrencyMismatchError', (_, operation) => {
      expect(() => operation(brl('1.00'), usd('1.00'))).toThrow(CurrencyMismatchError);
    });

    it('equals retorna false sem lançar', () => {
      expect(brl('1.00').equals(usd('1.00'))).toBe(false);
    });
  });

  describe('consultas', () => {
    it('isZero / isPositive / isNegative', () => {
      expect(Money.zero('BRL').isZero()).toBe(true);
      expect(brl('0.01').isPositive()).toBe(true);
      expect(brl('0.00').isPositive()).toBe(false);
      expect(brl('0.00').isNegative()).toBe(false);
    });

    it('isLessThan', () => {
      expect(brl('79.99').isLessThan(brl('80.00'))).toBe(true);
      expect(brl('80.00').isLessThan(brl('80.00'))).toBe(false);
    });
  });

  describe('serialization', () => {
    it('toJSON devolve MoneyProps com escala fixa', () => {
      expect(brl('25.00').toJSON()).toEqual({ amount: '25.00', currency: 'BRL' });
      expect(JSON.stringify({ money: brl('1.50') })).toBe('{"money":{"amount":"1.50","currency":"BRL"}}');
    });

    it('toString', () => {
      expect(brl('975.00').toString()).toBe('975.00 BRL');
    });
  });
});
