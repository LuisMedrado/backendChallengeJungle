// erros de domínio. Cada um tem um code estável para a camada de interface
export abstract class DomainError extends Error {
  abstract readonly code: string;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** valor monetário fora do contrato */
export class InvalidMoneyError extends DomainError {
  readonly code = 'INVALID_MONEY';
}

/** operação entre moedas diferentes */
export class CurrencyMismatchError extends DomainError {
  readonly code = 'CURRENCY_MISMATCH';
}

/** débito maior que o saldo disponível */
export class InsufficientBalanceError extends DomainError {
  readonly code = 'INSUFFICIENT_BALANCE';
}

/** lançamento de ledger com valores inválidos. */
export class InvalidLedgerEntryError extends DomainError {
  readonly code = 'INVALID_LEDGER_ENTRY';
}

/** payload de transação inválido */
export class InvalidWagerTransactionError extends DomainError {
  readonly code = 'INVALID_WAGER_TRANSACTION';
}

/** transição de estado inválida em WagerTransaction */
export class InvalidTransactionStateError extends DomainError {
  readonly code = 'INVALID_TRANSACTION_STATE';
}

/** transição de estado inválida em Inbox/Outbox */
export class InvalidStateTransitionError extends DomainError {
  readonly code = 'INVALID_STATE_TRANSITION';
}
