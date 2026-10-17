import { LedgerDirection } from '../ledger/wallet-ledger-entry';
import { Money } from '../money/money';
import { InvalidTransactionStateError, InvalidWagerTransactionError } from '../shared/errors';
import { FailureCode } from './failure-code';
import { REFERENCE_MAX_ATTEMPTS, referenceRetryDelayMs } from './reference-retry-policy';

export enum WagerTransactionKind {
  Opening = 'OPENING', // interno: crédito de abertura da wallet
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}

export enum WagerTransactionStatus {
  Pending = 'PENDING', // aceita, ainda não aplicada
  PendingReference = 'PENDING_REFERENCE', // aguardando a transação referenciada
  Processed = 'PROCESSED', // aplicada (terminal)
  Rejected = 'REJECTED', // violação de regra de negócio (terminal)
  Failed = 'FAILED', // erro permanente de infraestrutura (terminal, auditável)
}

const { Pending, PendingReference, Processed, Rejected, Failed } = WagerTransactionStatus;
const { Opening, Bet, Win, Loss, Refund, Rollback } = WagerTransactionKind;

// máquina de estados, PROCESSED, REJECTED e FAILED são terminais
const ALLOWED_TRANSITIONS: Record<WagerTransactionStatus, ReadonlySet<WagerTransactionStatus>> = {
  [Pending]: new Set([PendingReference, Processed, Rejected, Failed]),
  [PendingReference]: new Set([PendingReference, Processed, Rejected, Failed]),
  [Processed]: new Set(),
  [Rejected]: new Set(),
  [Failed]: new Set(),
};

// quais kinds cada operação pode referenciar
const REFERENCEABLE_KINDS: Record<WagerTransactionKind, ReadonlySet<WagerTransactionKind>> = {
  [Opening]: new Set(),
  [Bet]: new Set(),
  [Win]: new Set([Bet]),
  [Loss]: new Set([Bet]),
  [Refund]: new Set([Bet]),
  [Rollback]: new Set([Bet, Win, Refund]),
};

export const INTERNAL_PROVIDER_ID = 'internal';

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  /** id no provedor, não o id interno */
  referenceExternalTransactionId?: string;
  createdAt: Date;
}

export interface WagerTransactionState extends CreateWagerTransactionProps {
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  processedAt?: Date;
  /** saldo observado quando a transação foi decidida, devolvido nos replays */
  balanceAfter?: Money;
  referenceAttempts: number;
  nextReferenceCheckAt?: Date;
}

export interface CreateOpeningProps {
  id: string;
  walletId: string;
  playerId: string;
  money: Money;
  createdAt: Date;
}

export class WagerTransaction {
  public readonly id: string;
  public readonly providerId: string;
  public readonly externalTransactionId: string;
  public readonly idempotencyKey: string;
  public readonly payloadHash: string;
  public readonly walletId: string;
  public readonly playerId: string;
  public readonly roundId: string;
  public readonly gameId: string;
  public readonly kind: WagerTransactionKind;
  public readonly money: Money;
  public readonly referenceExternalTransactionId: string | undefined;
  public readonly createdAt: Date;

  private _status: WagerTransactionStatus;
  private _referenceTransactionId: string | undefined;
  private _failureCode: FailureCode | undefined;
  private _processedAt: Date | undefined;
  private _balanceAfter: Money | undefined;
  private _referenceAttempts: number;
  private _nextReferenceCheckAt: Date | undefined;

  private constructor(state: WagerTransactionState) {
    this.id = state.id;
    this.providerId = state.providerId;
    this.externalTransactionId = state.externalTransactionId;
    this.idempotencyKey = state.idempotencyKey;
    this.payloadHash = state.payloadHash;
    this.walletId = state.walletId;
    this.playerId = state.playerId;
    this.roundId = state.roundId;
    this.gameId = state.gameId;
    this.kind = state.kind;
    this.money = state.money;
    this.referenceExternalTransactionId = state.referenceExternalTransactionId;
    this.createdAt = state.createdAt;
    this._status = state.status;
    this._referenceTransactionId = state.referenceTransactionId;
    this._failureCode = state.failureCode;
    this._processedAt = state.processedAt;
    this._balanceAfter = state.balanceAfter;
    this._referenceAttempts = state.referenceAttempts;
    this._nextReferenceCheckAt = state.nextReferenceCheckAt;
  }

  /** nasce em PENDING e OPENING não é aceito aqui */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (props.kind === Opening) {
      throw new InvalidWagerTransactionError('OPENING é interno e não pode ser submetido');
    }
    WagerTransaction.validate(props);
    return new WagerTransaction({ ...props, status: Pending, referenceAttempts: 0 });
  }

  /** transação interna de abertura da wallet, já nasce PROCESSED (msm transação SQL da wallet) */
  static createOpening(props: CreateOpeningProps): WagerTransaction {
    if (!props.money.isPositive()) {
      throw new InvalidWagerTransactionError('OPENING só existe para saldo inicial positivo');
    }
    const externalTransactionId = `opening:${props.walletId}`;
    const idempotencyKey = `${INTERNAL_PROVIDER_ID}:${externalTransactionId}`;
    return new WagerTransaction({
      id: props.id,
      providerId: INTERNAL_PROVIDER_ID,
      externalTransactionId,
      idempotencyKey,
      payloadHash: idempotencyKey, // sem payload externo
      walletId: props.walletId,
      playerId: props.playerId,
      roundId: 'opening',
      gameId: INTERNAL_PROVIDER_ID,
      kind: Opening,
      money: props.money,
      createdAt: props.createdAt,
      status: Processed,
      processedAt: props.createdAt,
      balanceAfter: props.money,
      referenceAttempts: 0,
    });
  }

  /** reconstrução a partir da persistência */
  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(state);
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }
  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }
  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }
  get processedAt(): Date | undefined {
    return this._processedAt;
  }
  get balanceAfter(): Money | undefined {
    return this._balanceAfter;
  }
  get referenceAttempts(): number {
    return this._referenceAttempts;
  }
  get nextReferenceCheckAt(): Date | undefined {
    return this._nextReferenceCheckAt;
  }

  // transições (lançam InvalidTransactionStateError se a transição não for permitida)

  markProcessed(referenceTransactionId: string | undefined, at: Date, balanceAfter: Money): void {
    this.transitionTo(Processed);
    this._referenceTransactionId = referenceTransactionId;
    this._processedAt = at;
    this._balanceAfter = balanceAfter;
  }

  /** registra uma tentativa sem a referência e agenda a próxima */
  markPendingReference(now: Date): void {
    this.transitionTo(PendingReference);
    this._referenceAttempts += 1;
    this._nextReferenceCheckAt = new Date(now.getTime() + referenceRetryDelayMs(this._referenceAttempts));
  }

  reject(code: FailureCode, observedBalance?: Money): void {
    this.transitionTo(Rejected);
    this._failureCode = code;
    this._balanceAfter = observedBalance;
    this._nextReferenceCheckAt = undefined;
  }

  fail(code: FailureCode): void {
    this.transitionTo(Failed);
    this._failureCode = code;
    this._nextReferenceCheckAt = undefined;
  }

  // ---- consultas de domínio

  isTerminal(): boolean {
    return ALLOWED_TRANSITIONS[this._status].size === 0;
  }

  affectsBalance(): boolean {
    return this.kind !== Loss;
  }

  requiresReference(): boolean {
    return this.kind === Refund || this.kind === Rollback;
  }

  isReversal(): boolean {
    return this.requiresReference();
  }

  canReference(reference: WagerTransaction): boolean {
    return REFERENCEABLE_KINDS[this.kind].has(reference.kind);
  }

  hasExhaustedReferenceAttempts(): boolean {
    return this._referenceAttempts >= REFERENCE_MAX_ATTEMPTS;
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case Bet:
        return LedgerDirection.Debit;
      case Opening:
      case Win:
      case Refund:
        return LedgerDirection.Credit;
      case Rollback: {
        if (!reference) {
          throw new InvalidWagerTransactionError('ROLLBACK precisa da referência para definir a direção');
        }
        // inverso da referência, ou seja, BET vira crédito e WIN/REFUND vira débito
        return reference.ledgerDirectionFor() === LedgerDirection.Debit
          ? LedgerDirection.Credit
          : LedgerDirection.Debit;
      }
      case Loss:
        throw new InvalidWagerTransactionError('LOSS não movimenta saldo');
    }
  }

  private transitionTo(target: WagerTransactionStatus): void {
    if (!ALLOWED_TRANSITIONS[this._status].has(target)) {
      throw new InvalidTransactionStateError(
        `transição inválida ${this._status} -> ${target} na transação ${this.id}`,
      );
    }
    this._status = target;
  }

  private static validate(props: CreateWagerTransactionProps): void {
    const required: Record<string, string> = {
      providerId: props.providerId,
      externalTransactionId: props.externalTransactionId,
      idempotencyKey: props.idempotencyKey,
      payloadHash: props.payloadHash,
      walletId: props.walletId,
      playerId: props.playerId,
      roundId: props.roundId,
      gameId: props.gameId,
    };
    for (const [field, value] of Object.entries(required)) {
      if (typeof value !== 'string' || value.trim() === '') {
        throw new InvalidWagerTransactionError(`${field} é obrigatório`);
      }
    }

    const reference = props.referenceExternalTransactionId;
    const hasReference = reference !== undefined && reference !== '';
    if ((props.kind === Refund || props.kind === Rollback) && !hasReference) {
      throw new InvalidWagerTransactionError(`${props.kind} exige referenceExternalTransactionId`);
    }
    if (hasReference && REFERENCEABLE_KINDS[props.kind].size === 0) {
      throw new InvalidWagerTransactionError(`${props.kind} não aceita referência`);
    }
    if (hasReference && reference === props.externalTransactionId) {
      throw new InvalidWagerTransactionError('transação não pode referenciar a si mesma');
    }

    // LOSS registra resultado sem mover saldo e aceita zero, mas o resto exige valor positivo
    const validAmount = props.kind === Loss ? !props.money.isNegative() : props.money.isPositive();
    if (!validAmount) {
      throw new InvalidWagerTransactionError(`valor inválido para ${props.kind}`);
    }
  }
}
