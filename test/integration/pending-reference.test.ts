import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import type { Client } from 'pg';
import type { Clock } from '../../src/application/ports';
import { CreateWallet } from '../../src/application/use-cases/create-wallet';
import {
  type ProcessWagerCommand,
  ProcessWagerTransaction,
} from '../../src/application/use-cases/process-wager-transaction';
import { ResolvePendingReferences } from '../../src/application/use-cases/resolve-pending-references';
import { REFERENCE_MAX_ATTEMPTS } from '../../src/domain/wagering/reference-retry-policy';
import { WagerTransactionStatus } from '../../src/domain/wagering/wager-transaction';
import { createOrmConfig } from '../../src/infrastructure/persistence/mikro-orm.config';
import { PostgresUnitOfWork } from '../../src/infrastructure/persistence/postgres-unit-of-work';
import { UuidV7Generator } from '../../src/infrastructure/system';
import { connect, migrate, testDatabaseUrl } from './support/database';

// relógio controlado pelo teste, pra andar o backoff sem esperar de verdade
class TestClock implements Clock {
  constructor(private current = new Date('2026-10-17T12:00:00.000Z')) {}
  now(): Date {
    return this.current;
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

const ids = new UuidV7Generator();
let db: Client;
const instances: { orm: MikroORM; uow: PostgresUnitOfWork }[] = [];

async function newInstance() {
  const orm = await MikroORM.init(createOrmConfig(testDatabaseUrl()));
  const instance = { orm, uow: new PostgresUnitOfWork(orm, 5_000) };
  instances.push(instance);
  return instance;
}

beforeAll(async () => {
  await migrate('down');
  await migrate('up');
  db = await connect();
});

afterAll(async () => {
  await Promise.all(instances.map((i) => i.orm.close(true)));
  await db?.end();
});

// monta tudo de uma instância com o msm relógio
async function setup() {
  const clock = new TestClock();
  const { uow } = await newInstance();
  const processWager = new ProcessWagerTransaction(uow, clock, ids);
  const resolver = new ResolvePendingReferences(uow, clock, ids, 50);

  const createWallet = async (amount = '100.00') => {
    const wallet = await new CreateWallet(uow, clock, ids).execute({
      playerId: crypto.randomUUID(),
      initialBalance: { amount, currency: 'BRL' },
      trace: { correlationId: 'test' },
    });
    return { id: wallet.id, playerId: wallet.playerId };
  };

  const command = (wallet: { id: string; playerId: string }, overrides: Partial<ProcessWagerCommand> = {}) => {
    const externalTransactionId = overrides.externalTransactionId ?? `tx-${crypto.randomUUID()}`;
    return {
      providerId: 'provider-a',
      externalTransactionId,
      idempotencyKey: `provider-a:${externalTransactionId}`,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'round-1',
      gameId: 'tigrao',
      kind: 'BET',
      money: { amount: '10.00', currency: 'BRL' },
      trace: { correlationId: 'test' },
      ...overrides,
    } satisfies ProcessWagerCommand;
  };

  return { clock, uow, processWager, resolver, createWallet, command };
}

async function transactionRow(id: string) {
  const { rows } = await db.query(
    `SELECT status, failure_code, reference_attempts, next_reference_check_at, reference_transaction_id
       FROM wager_transactions WHERE id = $1`,
    [id],
  );
  return rows[0];
}

async function balanceOf(walletId: string): Promise<string> {
  const { rows } = await db.query<{ balance: string }>('SELECT balance FROM wallets WHERE id = $1', [walletId]);
  return rows[0]!.balance;
}

async function eventsOf(transactionId: string): Promise<string[]> {
  const { rows } = await db.query<{ event_type: string }>(
    `SELECT event_type FROM outbox_messages WHERE payload -> 'data' ->> 'transactionId' = $1 ORDER BY sequence`,
    [transactionId],
  );
  return rows.map((r) => r.event_type);
}

async function ledgerIsConsistent(walletId: string): Promise<boolean> {
  const { rows } = await db.query<{ consistent: boolean }>(
    `SELECT w.balance = COALESCE(SUM(CASE l.direction WHEN 'CREDIT' THEN l.amount ELSE -l.amount END), 0) AS consistent
       FROM wallets w LEFT JOIN wallet_ledger_entries l ON l.wallet_id = w.id
      WHERE w.id = $1 GROUP BY w.balance`,
    [walletId],
  );
  return rows[0]!.consistent;
}

describe('ResolvePendingReferences', () => {
  it('REFUND que chegou antes da BET é aplicado pelo worker quando a BET chega', async () => {
    const { processWager, resolver, createWallet, command } = await setup();
    const wallet = await createWallet('100.00');
    const betId = `bet-${crypto.randomUUID()}`;

    const refund = await processWager.execute(command(wallet, { kind: 'REFUND', referenceExternalTransactionId: betId }));
    expect(refund.transaction.status).toBe(WagerTransactionStatus.PendingReference);

    const bet = await processWager.execute(command(wallet, { externalTransactionId: betId }));
    expect(await balanceOf(wallet.id)).toBe('90.00');

    // a BET acordou o REFUND, então o próximo ciclo do worker já aplica sem esperar o backoff
    expect((await transactionRow(refund.transaction.id)).status).toBe('PENDING_REFERENCE');
    expect(await resolver.execute()).toMatchObject({ processed: 1, rejected: 0, rescheduled: 0 });

    const row = await transactionRow(refund.transaction.id);
    expect(row.status).toBe('PROCESSED');
    expect(row.reference_transaction_id).toBe(bet.transaction.id);
    expect(await balanceOf(wallet.id)).toBe('100.00');
    expect(await eventsOf(refund.transaction.id)).toEqual([
      'WagerTransactionPendingReference',
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);
    expect(await ledgerIsConsistent(wallet.id)).toBe(true);
  });

  it('quando a referência chega, quem esperava por ela é acordado na hora sem esperar o backoff', async () => {
    const { clock, processWager, resolver, createWallet, command } = await setup();
    const wallet = await createWallet('100.00');
    const betId = `bet-${crypto.randomUUID()}`;
    const refund = await processWager.execute(command(wallet, { kind: 'REFUND', referenceExternalTransactionId: betId }));

    // algumas tentativas sem a referência empurram o próximo check pra longe
    for (let i = 0; i < 4; i++) {
      clock.advance(5 * 60_000);
      await resolver.execute();
    }
    const before = await transactionRow(refund.transaction.id);
    expect(new Date(before.next_reference_check_at).getTime()).toBeGreaterThan(clock.now().getTime());

    // a BET chega e o REFUND sai no próximo ciclo, sem o relógio andar
    await processWager.execute(command(wallet, { externalTransactionId: betId }));
    expect(await resolver.execute()).toMatchObject({ processed: 1 });
    expect((await transactionRow(refund.transaction.id)).status).toBe('PROCESSED');
    expect(await balanceOf(wallet.id)).toBe('100.00');
  });

  it('referência ainda ausente: conta mais uma tentativa e agenda com backoff, sem evento novo', async () => {
    const { clock, processWager, resolver, createWallet, command } = await setup();
    const wallet = await createWallet('100.00');
    const refund = await processWager.execute(
      command(wallet, { kind: 'REFUND', referenceExternalTransactionId: 'nunca-chega' }),
    );

    clock.advance(2_000);
    expect(await resolver.execute()).toMatchObject({ processed: 0, rejected: 0, rescheduled: 1 });

    const row = await transactionRow(refund.transaction.id);
    expect(row.status).toBe('PENDING_REFERENCE');
    expect(row.reference_attempts).toBe(2);
    // segunda tentativa espera 4s
    expect(new Date(row.next_reference_check_at).getTime()).toBe(clock.now().getTime() + 4_000);
    expect(await eventsOf(refund.transaction.id)).toEqual(['WagerTransactionPendingReference']);
  });

  it('esgotado o limite de tentativas vira REJECTED com REFERENCE_NOT_FOUND e publica o evento', async () => {
    const { clock, processWager, resolver, createWallet, command } = await setup();
    const wallet = await createWallet('100.00');
    const refund = await processWager.execute(
      command(wallet, { kind: 'REFUND', referenceExternalTransactionId: 'nunca-chega' }),
    );

    // cada rodada pula o backoff inteiro, que tem teto de 5 min
    for (let i = 0; i < REFERENCE_MAX_ATTEMPTS + 2; i++) {
      clock.advance(5 * 60_000);
      await resolver.execute();
    }

    const row = await transactionRow(refund.transaction.id);
    expect(row.status).toBe('REJECTED');
    expect(row.failure_code).toBe('REFERENCE_NOT_FOUND');
    expect(row.reference_attempts).toBe(REFERENCE_MAX_ATTEMPTS);
    expect(row.next_reference_check_at).toBeNull();
    expect(await balanceOf(wallet.id)).toBe('100.00');
    expect(await eventsOf(refund.transaction.id)).toEqual(['WagerTransactionPendingReference', 'WagerTransactionRejected']);
  });

  it('ROLLBACK de WIN que chegou antes debita quando o WIN chega', async () => {
    const { clock, processWager, resolver, createWallet, command } = await setup();
    const wallet = await createWallet('100.00');
    const winId = `win-${crypto.randomUUID()}`;

    const rollback = await processWager.execute(
      command(wallet, { kind: 'ROLLBACK', money: { amount: '30.00', currency: 'BRL' }, referenceExternalTransactionId: winId }),
    );
    await processWager.execute(
      command(wallet, { kind: 'WIN', money: { amount: '30.00', currency: 'BRL' }, externalTransactionId: winId }),
    );
    expect(await balanceOf(wallet.id)).toBe('130.00');

    clock.advance(2_000);
    await resolver.execute();

    expect((await transactionRow(rollback.transaction.id)).status).toBe('PROCESSED');
    expect(await balanceOf(wallet.id)).toBe('100.00');
    expect(await ledgerIsConsistent(wallet.id)).toBe(true);
  });

  it('referência que chegou e foi rejeitada vira REJECTED com REFERENCE_NOT_PROCESSED', async () => {
    const { clock, processWager, resolver, createWallet, command } = await setup();
    const wallet = await createWallet('5.00');
    const betId = `bet-${crypto.randomUUID()}`;

    const refund = await processWager.execute(
      command(wallet, { kind: 'REFUND', money: { amount: '50.00', currency: 'BRL' }, referenceExternalTransactionId: betId }),
    );
    const bet = await processWager.execute(
      command(wallet, { money: { amount: '50.00', currency: 'BRL' }, externalTransactionId: betId }),
    );
    expect(bet.transaction.status).toBe(WagerTransactionStatus.Rejected);

    clock.advance(2_000);
    expect(await resolver.execute()).toMatchObject({ rejected: 1 });

    const row = await transactionRow(refund.transaction.id);
    expect(row.status).toBe('REJECTED');
    expect(row.failure_code).toBe('REFERENCE_NOT_PROCESSED');
    expect(await balanceOf(wallet.id)).toBe('5.00');
  });

  it('replay da operação depois de resolvida devolve o estado atual', async () => {
    const { clock, processWager, resolver, createWallet, command } = await setup();
    const wallet = await createWallet('100.00');
    const betId = `bet-${crypto.randomUUID()}`;
    const refundCommand = command(wallet, { kind: 'REFUND', referenceExternalTransactionId: betId });

    await processWager.execute(refundCommand);
    await processWager.execute(command(wallet, { externalTransactionId: betId }));
    clock.advance(2_000);
    await resolver.execute();

    const replay = await processWager.execute(refundCommand);
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.transaction.status).toBe(WagerTransactionStatus.Processed);
    expect(replay.transaction.balanceAfter?.amount).toBe('100.00');
  });

  it('dois workers em instâncias separadas não aplicam a msm transação duas vezes', async () => {
    const a = await setup();
    const instanceB = await newInstance();
    const resolverB = new ResolvePendingReferences(instanceB.uow, a.clock, ids, 50);
    const wallet = await a.createWallet('100.00');

    // 10 REFUNDs chegam antes das BETs, depois as BETs chegam
    const refundIds: string[] = [];
    for (let i = 0; i < 10; i++) {
      const betId = `bet-${crypto.randomUUID()}`;
      const refund = await a.processWager.execute(
        a.command(wallet, { kind: 'REFUND', money: { amount: '5.00', currency: 'BRL' }, referenceExternalTransactionId: betId }),
      );
      refundIds.push(refund.transaction.id);
      await a.processWager.execute(a.command(wallet, { money: { amount: '5.00', currency: 'BRL' }, externalTransactionId: betId }));
    }
    expect(await balanceOf(wallet.id)).toBe('50.00');

    a.clock.advance(2_000);
    const [resultA, resultB] = await Promise.all([a.resolver.execute(), resolverB.execute()]);

    // cada REFUND foi aplicado por exatamente uma das instâncias
    expect(resultA.processed + resultB.processed).toBe(10);
    for (const id of refundIds) expect((await transactionRow(id)).status).toBe('PROCESSED');
    expect(await balanceOf(wallet.id)).toBe('100.00');
    expect(await ledgerIsConsistent(wallet.id)).toBe(true);
  });
});
