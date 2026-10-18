// tokens de injeção pras portas, use cases são classes e usam a própria classe como token
export const MIKRO_ORM = Symbol('MIKRO_ORM');
export const UNIT_OF_WORK = Symbol('UNIT_OF_WORK');
export const CLOCK = Symbol('CLOCK');
export const ID_GENERATOR = Symbol('ID_GENERATOR');
export const SQS_CLIENT = Symbol('SQS_CLIENT');
export const EVENT_PUBLISHER = Symbol('EVENT_PUBLISHER');
export const OUTBOX_WORKER = Symbol('OUTBOX_WORKER');
