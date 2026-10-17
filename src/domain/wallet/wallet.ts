import { LedgerDirection, WalletLedgerEntry } from '../ledger/wallet-ledger-entry';
import { Money } from '../money/money';
import { CurrencyMismatchError, InsufficientBalanceError, InvalidMoneyError } from '../shared/errors';

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface OpenWalletProps {
  id: string;
  playerId: string;
  initialBalance: Money;
  /** ids da transaçao OPENING e do lançamento correspondentes que so sao usados se saldo > 0 */
  openingTransactionId: string;
  openingLedgerEntryId: string;
  at: Date;
}

export interface OpenedWallet {
  wallet: Wallet;
  /** Lançamento CREDIT da abertura, eh ausente quando o saldo inicial é zero */
  openingEntry: WalletLedgerEntry | undefined;
}

export interface WalletMovement {
  ledgerEntryId: string;
  transactionId: string;
  money: Money;
  at: Date;
}

/**
 * aggregate root que faz com que toda alteração de saldo passe por debit ou credit, que devolvem
 * o lançamento do ledger correspondente, pq saldo e ledger nunca divergem.
 * o version vai começar em 1 e só vai incrementar quando o saldo mudar
 */
export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static open(props: OpenWalletProps): OpenedWallet {
    if (props.initialBalance.isNegative()) {
      throw new InvalidMoneyError('saldo inicial não pode ser negativo');
    }
    const { currency } = props.initialBalance;
    const wallet = new Wallet(props.id, props.playerId, currency, props.initialBalance, 1, props.at, props.at);

    const openingEntry = props.initialBalance.isZero()
      ? undefined
      : WalletLedgerEntry.create({
          id: props.openingLedgerEntryId,
          walletId: props.id,
          transactionId: props.openingTransactionId,
          direction: LedgerDirection.Credit,
          money: props.initialBalance,
          balanceBefore: Money.zero(currency),
          balanceAfter: props.initialBalance,
          createdAt: props.at,
        });

    return { wallet, openingEntry };
  }

  /** não revalida transições pegando a partir da persistência */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  canDebit(money: Money): boolean {
    this.assertSameCurrency(money);
    return !this._balance.isLessThan(money);
  }

  debit(movement: WalletMovement): WalletLedgerEntry {
    this.assertValidMovement(movement.money);
    if (!this.canDebit(movement.money)) {
      throw new InsufficientBalanceError(`saldo insuficiente na wallet ${this.id}`);
    }
    return this.apply(LedgerDirection.Debit, movement);
  }

  credit(movement: WalletMovement): WalletLedgerEntry {
    this.assertValidMovement(movement.money);
    return this.apply(LedgerDirection.Credit, movement);
  }

  private apply(direction: LedgerDirection, movement: WalletMovement): WalletLedgerEntry {
    const balanceBefore = this._balance;
    const balanceAfter =
      direction === LedgerDirection.Debit
        ? balanceBefore.subtract(movement.money)
        : balanceBefore.add(movement.money);

    // cria e valida o lançamento antes de mutar, aí se falhar, a wallet fica intacta
    const entry = WalletLedgerEntry.create({
      id: movement.ledgerEntryId,
      walletId: this.id,
      transactionId: movement.transactionId,
      direction,
      money: movement.money,
      balanceBefore,
      balanceAfter,
      createdAt: movement.at,
    });

    this._balance = balanceAfter;
    this._version += 1;
    this._updatedAt = movement.at;
    return entry;
  }

  private assertValidMovement(money: Money): void {
    this.assertSameCurrency(money);
    if (!money.isPositive()) {
      throw new InvalidMoneyError('valor da movimentação deve ser positivo');
    }
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError(`wallet em ${this.currency}, operação em ${money.currency}`);
    }
  }
}
