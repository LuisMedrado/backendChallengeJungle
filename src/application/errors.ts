// erros da camada de aplicação, cada um com code estável pra interface mapear pra status http
export abstract class ApplicationError extends Error {
  abstract readonly code: string;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** payload ou parâmetro inválido que não é regra de domínio, tipo header faltando ou cursor inválido */
export class InvalidRequestError extends ApplicationError {
  readonly code = 'INVALID_PAYLOAD';
}

export class WalletNotFoundError extends ApplicationError {
  readonly code = 'WALLET_NOT_FOUND';

  constructor(walletId: string) {
    super(`wallet ${walletId} não encontrada`);
  }
}

export class WagerTransactionNotFoundError extends ApplicationError {
  readonly code = 'TRANSACTION_NOT_FOUND';

  constructor(reference: string) {
    super(`transação ${reference} não encontrada`);
  }
}

export class WalletAlreadyExistsError extends ApplicationError {
  readonly code = 'WALLET_ALREADY_EXISTS';

  constructor(playerId: string, currency: string) {
    super(`player ${playerId} já tem wallet em ${currency}`);
  }
}

/** msm idempotency key ou msm transação do provedor com payload diferente, é conflito e não replay */
export class IdempotencyConflictError extends ApplicationError {
  readonly code = 'IDEMPOTENCY_KEY_CONFLICT';

  constructor(idempotencyKey: string) {
    super(`idempotency key ${idempotencyKey} já usada com outro payload`);
  }
}

// ---- erros que a infraestrutura traduz pra aplicação, sem vazar tipo do driver

/** violação de unique no banco, o use case decide o que significa */
export class DuplicateKeyError extends ApplicationError {
  readonly code = 'DUPLICATE_KEY';

  constructor(readonly constraint: string | undefined) {
    super(`violação de unicidade${constraint ? ` em ${constraint}` : ''}`);
  }
}

/** banco fora, deadlock, timeout... vale tentar de novo depois */
export class TransientInfrastructureError extends ApplicationError {
  readonly code = 'SERVICE_UNAVAILABLE';
}

/** update da wallet não achou a version esperada, alguém mexeu no meio */
export class ConcurrentModificationError extends ApplicationError {
  readonly code = 'CONCURRENT_MODIFICATION';
}
