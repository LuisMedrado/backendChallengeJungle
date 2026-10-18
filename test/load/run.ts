// teste de carga: sobe 3 instâncias de verdade contra o banco de teste e mede http e fila
// zera o wagering_test e esvazia as filas antes de começar, então não roda junto com a suíte
import { cpus, platform, release, totalmem } from 'node:os';
import { resolve } from 'node:path';
import type { SQSClient } from '@aws-sdk/client-sqs';
import type { Client } from 'pg';
import { createSqsClient } from '../../src/infrastructure/messaging/sqs-client';
import { connect, migrate, walletsOutOfBalance } from '../integration/support/database';
import { deadLetterQueueUrl, eventsQueueUrl, purgeQueue, sendToQueue, wagerQueueUrl } from '../integration/support/sqs';
import { type Instance, freePorts, killInstance, startCluster } from '../concurrency/support/instances';
import { type LatencySummary, parseMetrics, sumMetric, summarize } from './stats';

const config = {
  instances: 3,
  durationSeconds: intEnv('LOAD_DURATION_SECONDS', 20),
  warmupSeconds: intEnv('LOAD_WARMUP_SECONDS', 3),
  concurrency: intEnv('LOAD_CONCURRENCY', 32),
  wallets: intEnv('LOAD_WALLETS', 200),
  queueMessages: intEnv('LOAD_QUEUE_MESSAGES', 2000),
  queueWallets: 50,
};

// tempo máximo esperando a outbox zerar. backlog grande demora, e isso é parte do resultado
const DRAIN_TIMEOUT_MS = 600_000;

const REPORT_PATH = resolve(import.meta.dir, '../../load-test-results.md');

type Wallet = { id: string; playerId: string };

interface HttpScenarioResult {
  name: string;
  description: string;
  wallets: number;
  measuredSeconds: number;
  requests: number;
  throughput: number;
  statuses: Record<string, number>;
  errorRate: number;
  latency: LatencySummary;
  serverMeanMs: number;
  lockConflicts: Record<string, number>;
  maxOutboxPending: number;
  maxOutboxLagSeconds: number;
  outboxDrainSeconds: number;
  outboxEvents: number;
  outboxPerSecond: number;
  correct: boolean;
  correctnessNote: string;
}

interface QueueScenarioResult {
  messages: number;
  wallets: number;
  seconds: number;
  enqueueSeconds: number;
  throughput: number;
  latency: LatencySummary;
  dlq: number;
  inboxDuplicates: number;
  correct: boolean;
}

let instances: Instance[] = [];
let db: Client | undefined;
let sqs: SQSClient | undefined;

// atalhos pros dois, que só existem depois do main abrir
const pg = (): Client => db!;
const broker = (): SQSClient => sqs!;

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} tem que ser inteiro positivo`);
  return value;
}

function log(message: string): void {
  console.log(`[load] ${message}`);
}

const brl = (amount: string) => ({ amount, currency: 'BRL' });

function bet(wallet: Wallet, externalTransactionId = `load-${crypto.randomUUID()}`) {
  return {
    providerId: 'provider-load',
    externalTransactionId,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'round-load',
    gameId: 'load',
    kind: 'BET',
    money: brl('1.00'),
  };
}

async function createWallets(count: number): Promise<Wallet[]> {
  const wallets: Wallet[] = [];
  for (let i = 0; i < count; i++) {
    const res = await fetch(`${instances[i % instances.length]!.baseUrl}/wallets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ playerId: crypto.randomUUID(), initialBalance: brl('1000000.00') }),
    });
    if (res.status !== 201) throw new Error(`criar wallet deu ${res.status}`);
    wallets.push((await res.json()) as Wallet);
  }
  return wallets;
}

// soma as métricas das 3 instâncias, cada uma tem o próprio registry
async function clusterMetrics(): Promise<Map<string, number>> {
  const total = new Map<string, number>();
  for (const instance of instances) {
    const metrics = parseMetrics(await (await fetch(`${instance.baseUrl}/metrics`)).text());
    for (const [key, value] of metrics) total.set(key, (total.get(key) ?? 0) + value);
  }
  return total;
}

// gauge de outbox é lido do banco, então qualquer instância serve
async function outboxGauges(): Promise<{ pending: number; lag: number }> {
  const metrics = parseMetrics(await (await fetch(`${instances[0]!.baseUrl}/metrics`)).text());
  return { pending: sumMetric(metrics, 'wagering_outbox_pending'), lag: sumMetric(metrics, 'wagering_outbox_lag_seconds') };
}

function delta(after: Map<string, number>, before: Map<string, number>, name: string, labels: Record<string, string> = {}) {
  return sumMetric(after, name, labels) - sumMetric(before, name, labels);
}

async function waitOutboxDrained(timeoutMs: number): Promise<number> {
  const start = performance.now();
  while (performance.now() - start < timeoutMs) {
    if ((await outboxGauges()).pending === 0) return (performance.now() - start) / 1000;
    await Bun.sleep(100);
  }
  return Number.NaN;
}

// cada cenário começa com a outbox vazia, senão o backlog de um contamina o próximo
async function settleOutbox(): Promise<void> {
  if (Number.isNaN(await waitOutboxDrained(DRAIN_TIMEOUT_MS))) throw new Error('outbox não zerou antes do cenário');
}

// vazão da outbox medida no banco: do primeiro evento do cenário até o último publicado, tudo no relógio da aplicação
async function outboxThroughput(since: Date): Promise<{ events: number; perSecond: number }> {
  const { rows } = await pg().query<{ events: number; seconds: number | null }>(
    `SELECT count(*)::int AS events, extract(epoch FROM max(published_at) - min(occurred_at))::float AS seconds
       FROM outbox_messages WHERE occurred_at >= $1`,
    [since],
  );
  const { events, seconds } = rows[0]!;
  return { events, perSecond: seconds ? events / seconds : Number.NaN };
}

async function runHttpScenario(name: string, description: string, wallets: Wallet[]): Promise<HttpScenarioResult> {
  await settleOutbox();
  log(`cenário ${name}: ${config.concurrency} clientes por ${config.durationSeconds}s, ${wallets.length} wallet(s)`);
  const before = await clusterMetrics();
  const since = new Date();

  let maxPending = 0;
  let maxLag = 0;
  let sampling = true;
  const sampler = (async () => {
    while (sampling) {
      const gauges = await outboxGauges();
      maxPending = Math.max(maxPending, gauges.pending);
      maxLag = Math.max(maxLag, gauges.lag);
      await Bun.sleep(500);
    }
  })();

  const latencies: number[] = [];
  const statuses: Record<string, number> = {};
  let processedResponses = 0;
  let next = 0;
  const startedAt = performance.now();
  const measureFrom = startedAt + config.warmupSeconds * 1000;
  const endAt = measureFrom + config.durationSeconds * 1000;

  // carga em malha fechada: cada cliente manda a próxima assim que a anterior volta
  const client = async () => {
    while (performance.now() < endAt) {
      const n = next++;
      const body = bet(wallets[n % wallets.length]!);
      const t0 = performance.now();
      let status: string;
      try {
        const res = await fetch(`${instances[n % instances.length]!.baseUrl}/wagering/transactions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'Idempotency-Key': `provider-load:${body.externalTransactionId}` },
          body: JSON.stringify(body),
        });
        await res.arrayBuffer();
        status = String(res.status);
      } catch {
        status = 'erro de rede';
      }
      const t1 = performance.now();
      if (status === '200') processedResponses++;
      if (t0 >= measureFrom) {
        latencies.push(t1 - t0);
        statuses[status] = (statuses[status] ?? 0) + 1;
      }
    }
  };
  await Promise.all(Array.from({ length: config.concurrency }, client));

  const outboxDrainSeconds = await waitOutboxDrained(DRAIN_TIMEOUT_MS);
  sampling = false;
  await sampler;
  const after = await clusterMetrics();
  const outbox = await outboxThroughput(since);

  const requests = latencies.length;
  const failed = Object.entries(statuses)
    .filter(([status]) => status !== '200' && status !== '422')
    .reduce((sum, [, count]) => sum + count, 0);

  const { rows } = await pg().query<{ n: number }>(
    `SELECT count(*)::int AS n FROM wager_transactions WHERE kind = 'BET' AND status = 'PROCESSED' AND wallet_id = ANY($1)`,
    [wallets.map((wallet) => wallet.id)],
  );
  const outOfBalance = await walletsOutOfBalance(pg());
  const correct = rows[0]!.n === processedResponses && outOfBalance.length === 0;

  const serverCount = delta(after, before, 'wagering_processing_duration_seconds_count', { channel: 'http' });
  const serverSum = delta(after, before, 'wagering_processing_duration_seconds_sum', { channel: 'http' });

  return {
    name,
    description,
    wallets: wallets.length,
    measuredSeconds: config.durationSeconds,
    requests,
    throughput: requests / config.durationSeconds,
    statuses,
    errorRate: requests === 0 ? 0 : failed / requests,
    latency: summarize(latencies),
    serverMeanMs: serverCount === 0 ? Number.NaN : (serverSum / serverCount) * 1000,
    lockConflicts: Object.fromEntries(
      ['lock_timeout', 'deadlock', 'version_mismatch', 'idempotency_race'].map((type) => [
        type,
        delta(after, before, 'wagering_lock_conflicts_total', { type }),
      ]),
    ),
    maxOutboxPending: maxPending,
    maxOutboxLagSeconds: maxLag,
    outboxDrainSeconds,
    outboxEvents: outbox.events,
    outboxPerSecond: outbox.perSecond,
    correct,
    correctnessNote: `${rows[0]!.n} BETs PROCESSED no banco, ${processedResponses} respostas 200, ${outOfBalance.length} wallets com saldo != ledger`,
  };
}

async function runQueueScenario(wallets: Wallet[]): Promise<QueueScenarioResult> {
  await settleOutbox();
  log(`cenário fila: ${config.queueMessages} mensagens em ${wallets.length} wallets`);
  const before = await clusterMetrics();
  const sentAt = new Map<string, number>();
  const ids: string[] = [];

  let next = 0;
  const startedAt = Date.now();
  const sender = async () => {
    while (next < config.queueMessages) {
      const n = next++;
      const wallet = wallets[n % wallets.length]!;
      const externalTransactionId = `load-q-${crypto.randomUUID()}`;
      const message = {
        messageId: `msg-${crypto.randomUUID()}`,
        type: 'WagerTransactionRequested',
        occurredAt: new Date().toISOString(),
        data: { ...bet(wallet, externalTransactionId), idempotencyKey: `provider-load:${externalTransactionId}` },
      };
      sentAt.set(externalTransactionId, Date.now());
      await sendToQueue(broker(), wagerQueueUrl(), message, { groupId: wallet.id });
      ids.push(externalTransactionId);
    }
  };
  await Promise.all(Array.from({ length: 25 }, sender));
  const enqueueSeconds = (Date.now() - startedAt) / 1000;

  const deadline = Date.now() + 300_000;
  let done = 0;
  while (Date.now() < deadline) {
    const { rows } = await pg().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM wager_transactions WHERE external_transaction_id = ANY($1) AND status = 'PROCESSED'`,
      [ids],
    );
    done = rows[0]!.n;
    if (done === config.queueMessages) break;
    await Bun.sleep(250);
  }

  const { rows } = await pg().query<{ id: string; processed_at: Date }>(
    `SELECT external_transaction_id AS id, processed_at FROM wager_transactions WHERE external_transaction_id = ANY($1)`,
    [ids],
  );
  const latencies = rows.map((row) => new Date(row.processed_at).getTime() - sentAt.get(row.id)!);
  const lastProcessed = Math.max(...rows.map((row) => new Date(row.processed_at).getTime()));
  const seconds = (lastProcessed - startedAt) / 1000;

  await waitOutboxDrained(DRAIN_TIMEOUT_MS);
  const after = await clusterMetrics();
  const dlq = sumMetric(after, 'wagering_dlq_depth') / instances.length;
  const outOfBalance = await walletsOutOfBalance(pg());

  return {
    messages: config.queueMessages,
    wallets: wallets.length,
    seconds,
    enqueueSeconds,
    throughput: done / seconds,
    latency: summarize(latencies),
    dlq,
    inboxDuplicates: delta(after, before, 'wagering_duplicates_total', { type: 'inbox_message' }),
    correct: done === config.queueMessages && outOfBalance.length === 0 && dlq === 0,
  };
}

async function environment(): Promise<string[]> {
  const { rows } = await pg().query<{ server_version: string }>('SHOW server_version');
  const cpu = cpus();
  return [
    `- máquina: ${cpu[0]?.model.trim()} (${cpu.length} threads), ${(totalmem() / 1024 ** 3).toFixed(1)} GB de RAM`,
    `- sistema: ${platform()} ${release()}, Docker Desktop`,
    `- Bun ${Bun.version}, PostgreSQL ${rows[0]!.server_version}, LocalStack 4.4`,
    `- ${config.instances} instâncias da aplicação, pool padrão do MikroORM (até 10 conexões por instância)`,
    '- gerador de carga, aplicação, Postgres e LocalStack na mesma máquina',
  ];
}

const fmt = (value: number, digits = 1) => (Number.isFinite(value) ? value.toFixed(digits) : '-');

function render(env: string[], http: HttpScenarioResult[], queue: QueueScenarioResult): string {
  const lines = [
    '# Resultado do teste de carga',
    '',
    `Gerado por \`bun run test:load\` em ${new Date().toISOString()}.`,
    '',
    '## Ambiente',
    '',
    ...env,
    '',
    '## Metodologia',
    '',
    `- carga em malha fechada: ${config.concurrency} clientes, cada um manda a próxima aposta assim que a anterior volta, sem retry`,
    `- ${config.warmupSeconds}s de aquecimento fora da conta, depois ${config.durationSeconds}s medidos por cenário`,
    '- toda requisição é uma BET de 1.00 com chave nova, distribuída em rodízio entre as instâncias',
    '- latência medida no cliente, do envio até o fim da resposta. a média do servidor vem do histograma da aplicação',
    '- conflitos de lock vêm do `/metrics` das 3 instâncias somadas, outbox lag é amostrado a cada 500ms',
    '- cada cenário só começa com a outbox zerada. a vazão da outbox é medida no banco, do primeiro evento criado ao último publicado',
    '- no fim de cada cenário confere BETs PROCESSED no banco == respostas 200 e saldo == ledger em todas as wallets',
    '',
    '## HTTP',
    '',
    '| | ' + http.map((r) => r.name).join(' | ') + ' |',
    '|---|' + http.map(() => '---|').join(''),
    row('wallets', http.map((r) => String(r.wallets))),
    row('requisições medidas', http.map((r) => String(r.requests))),
    row('throughput (req/s)', http.map((r) => fmt(r.throughput))),
    row('p50 (ms)', http.map((r) => fmt(r.latency.p50))),
    row('p95 (ms)', http.map((r) => fmt(r.latency.p95))),
    row('p99 (ms)', http.map((r) => fmt(r.latency.p99))),
    row('máximo (ms)', http.map((r) => fmt(r.latency.max))),
    row('média no servidor (ms)', http.map((r) => fmt(r.serverMeanMs))),
    row('status', http.map((r) => Object.entries(r.statuses).map(([s, n]) => `${s}: ${n}`).join(', '))),
    row('taxa de erro', http.map((r) => `${fmt(r.errorRate * 100, 2)}%`)),
    row('lock_timeout', http.map((r) => String(r.lockConflicts.lock_timeout))),
    row('version_mismatch', http.map((r) => String(r.lockConflicts.version_mismatch))),
    row('deadlock', http.map((r) => String(r.lockConflicts.deadlock))),
    row('outbox pendente máx.', http.map((r) => String(r.maxOutboxPending))),
    row('outbox lag máx. (s)', http.map((r) => fmt(r.maxOutboxLagSeconds, 2))),
    row('outbox zerada após o fim da carga (s)', http.map((r) => fmt(r.outboxDrainSeconds, 1))),
    row('eventos gerados', http.map((r) => String(r.outboxEvents))),
    row('vazão da outbox (eventos/s)', http.map((r) => fmt(r.outboxPerSecond))),
    row('consistência', http.map((r) => (r.correct ? 'ok' : 'FALHOU'))),
    '',
    ...http.map((r) => `- ${r.name}: ${r.description}. ${r.correctnessNote}`),
    '',
    '## Fila',
    '',
    `${queue.messages} mensagens enviadas pra \`wager-transactions.fifo\` por 25 produtores, em ${queue.wallets} wallets, ` +
      'com os 3 consumers ligados. A latência vai do envio até o `processed_at` gravado no banco.',
    '',
    '| | fila |',
    '|---|---|',
    row('throughput (msg/s)', [fmt(queue.throughput)]),
    row('tempo pra enfileirar tudo (s)', [fmt(queue.enqueueSeconds)]),
    row('tempo até processar tudo (s)', [fmt(queue.seconds)]),
    row('p50 (ms)', [fmt(queue.latency.p50)]),
    row('p95 (ms)', [fmt(queue.latency.p95)]),
    row('p99 (ms)', [fmt(queue.latency.p99)]),
    row('DLQ', [String(queue.dlq)]),
    row('duplicatas pela inbox', [String(queue.inboxDuplicates)]),
    row('consistência', [queue.correct ? 'ok' : 'FALHOU']),
    '',
  ];
  return lines.join('\n');
}

function row(label: string, values: string[]): string {
  return `| ${label} | ${values.join(' | ')} |`;
}

async function main(): Promise<void> {
  log('zerando o banco de teste e as filas');
  await migrate('down');
  await migrate('up');
  db = await connect();
  sqs = createSqsClient();
  for (const url of [wagerQueueUrl(), deadLetterQueueUrl(), eventsQueueUrl()]) await purgeQueue(broker(), url);

  log(`subindo ${config.instances} instâncias`);
  instances = await startCluster(await freePorts(config.instances));

  const env = await environment();
  const spread = await createWallets(config.wallets);
  const hot = await createWallets(1);
  const http = [
    await runHttpScenario('distribuído', `carga espalhada em ${config.wallets} wallets, mostra o paralelismo entre wallets`, spread),
    await runHttpScenario('hot wallet', 'toda a carga numa wallet só, mostra o custo do lock por wallet', hot),
  ];
  const queue = await runQueueScenario(await createWallets(config.queueWallets));

  const report = render(env, http, queue);
  await Bun.write(REPORT_PATH, report);
  console.log(`\n${report}`);
  log(`relatório salvo em ${REPORT_PATH}`);

  if (!http.every((r) => r.correct) || !queue.correct) {
    log('consistência FALHOU, olha o relatório');
    process.exitCode = 1;
  }
}

try {
  await main();
} finally {
  await Promise.all(instances.map((instance) => killInstance(instance).catch(() => {})));
  await db?.end();
  sqs?.destroy();
}
