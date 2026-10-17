import { IntegrationEvent } from '../events/integration-event';
import { InvalidStateTransitionError } from '../shared/errors';

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt?: Date;
  publishedAt?: Date;
}

// backoff de publicação exponencial sem limite de tentativas:
// um evento confirmado nunca eh descartado, falhas persistentes aparecem na métrica de outbox
const OUTBOX_BASE_DELAY_MS = 1_000;
const OUTBOX_MAX_DELAY_MS = 60_000;

export class OutboxMessage {
  private constructor(
    public readonly id: string,
    public readonly aggregateId: string,
    public readonly eventType: string,
    public readonly payload: Readonly<Record<string, unknown>>,
    public readonly occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt?: Date,
    private _publishedAt?: Date,
  ) {}

  /** o id da mensagem é o eventId, publicação duplicada carrega o mesmo id para o consumer deduplicar */
  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    // roundtrip pra garantir que o payload é JSON e passa datas pra ISO
    const payload = Object.freeze(JSON.parse(JSON.stringify(event.toJSON())) as Record<string, unknown>);
    return new OutboxMessage(event.eventId, event.aggregateId, event.eventType, payload, event.occurredAt, 0);
  }

  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(
      state.id,
      state.aggregateId,
      state.eventType,
      state.payload,
      state.occurredAt,
      state.attempts,
      state.nextAttemptAt,
      state.publishedAt,
    );
  }

  get attempts(): number {
    return this._attempts;
  }
  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt;
  }
  get publishedAt(): Date | undefined {
    return this._publishedAt;
  }

  isPending(): boolean {
    return this._publishedAt === undefined;
  }

  isDue(now: Date): boolean {
    return (
      this.isPending() && (this._nextAttemptAt === undefined || this._nextAttemptAt.getTime() <= now.getTime())
    );
  }

  markPublished(at: Date): void {
    this.assertPending();
    this._publishedAt = at;
  }

  /** incrementa attempts e calcula o próximo nextAttemptAt pro backoff */
  scheduleRetry(now: Date): void {
    this.assertPending();
    this._attempts += 1;
    const delay = Math.min(OUTBOX_BASE_DELAY_MS * 2 ** (this._attempts - 1), OUTBOX_MAX_DELAY_MS);
    this._nextAttemptAt = new Date(now.getTime() + delay);
  }

  private assertPending(): void {
    if (!this.isPending()) {
      throw new InvalidStateTransitionError(`evento ${this.id} já publicado`);
    }
  }
}
