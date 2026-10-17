import { CurrencyMismatchError, InvalidMoneyError } from '../shared/errors';

/** contrato de entrada e saída é de valor como string decimal com exatamente 2 casas */
export interface MoneyProps {
  amount: string; // tipo 25.00
  currency: string;
}

// até 19 digitos com 2 sendo decimais pra caber em NUMERIC(19,2)
// rejeita sinal, notação científica, NaN, infinity, zeros à esquerda e escala diferente de 2
const AMOUNT_PATTERN = /^(0|[1-9]\d{0,16})\.\d{2}$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const MINOR_UNITS_PER_UNIT = 100n;

/**
 * internamente guarda centavos em bigint:
 * aritmética exata, sem float e sem ext dep
 */
export class Money {
  private constructor(
    private readonly minorUnits: bigint,
    public readonly currency: string,
  ) {
    Object.freeze(this);
  }

  static from(props: MoneyProps): Money {
    if (typeof props.amount !== 'string' || !AMOUNT_PATTERN.test(props.amount)) {
      throw new InvalidMoneyError(
        'amount inválido: esperado decimal não negativo',
      );
    }
    Money.assertCurrency(props.currency);
    return new Money(BigInt(props.amount.replace('.', '')), props.currency);
  }

  static zero(currency: string): Money {
    Money.assertCurrency(currency);
    return new Money(0n, currency);
  }

  /** valor como string decimal com 2 casas */
  get amount(): string {
    const negative = this.minorUnits < 0n;
    const abs = negative ? -this.minorUnits : this.minorUnits;
    const units = abs / MINOR_UNITS_PER_UNIT;
    const cents = (abs % MINOR_UNITS_PER_UNIT).toString().padStart(2, '0');
    return `${negative ? '-' : ''}${units}.${cents}`;
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.minorUnits + other.minorUnits, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.minorUnits - other.minorUnits, this.currency);
  }

  negate(): Money {
    return new Money(-this.minorUnits, this.currency);
  }

  isZero(): boolean {
    return this.minorUnits === 0n;
  }

  isPositive(): boolean {
    return this.minorUnits > 0n;
  }

  isNegative(): boolean {
    return this.minorUnits < 0n;
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.minorUnits < other.minorUnits;
  }

  /** garantir que moedas diferentes nunca são iguais */
  equals(other: Money): boolean {
    return this.currency === other.currency && this.minorUnits === other.minorUnits;
  }

  toJSON(): MoneyProps {
    return { amount: this.amount, currency: this.currency };
  }

  toString(): string {
    return `${this.amount} ${this.currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (other.currency !== this.currency) {
      throw new CurrencyMismatchError(`moedas diferentes: ${this.currency} e ${other.currency}`);
    }
  }

  private static assertCurrency(currency: unknown): asserts currency is string {
    if (typeof currency !== 'string' || !CURRENCY_PATTERN.test(currency)) {
      throw new InvalidMoneyError('currency inválida: esperado código ISO-4217 (ex.: "BRL")');
    }
  }
}
