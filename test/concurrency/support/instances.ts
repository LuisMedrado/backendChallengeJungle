import { resolve } from 'node:path';
import type { Subprocess } from 'bun';
import { testDatabaseUrl } from '../../integration/support/database';

const PROJECT_ROOT = resolve(import.meta.dir, '../../..');

export interface Instance {
  port: number;
  baseUrl: string;
  process: Subprocess;
}

export interface HttpResult {
  status: number;
  body: any;
}

// sobe um processo da aplicação de verdade, com http, consumer e os dois workers ligados
export async function startInstance(port: number): Promise<Instance> {
  const child = Bun.spawn([process.execPath, 'src/main.ts'], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      DATABASE_URL: testDatabaseUrl(),
      SQS_CONSUMER_ENABLED: 'true',
      SQS_WAIT_TIME_SECONDS: '1',
      OUTBOX_PUBLISHER_ENABLED: 'true',
      OUTBOX_POLL_INTERVAL_MS: '100',
      PENDING_REFERENCE_WORKER_ENABLED: 'true',
      PENDING_REFERENCE_POLL_INTERVAL_MS: '100',
    },
    stdout: 'ignore',
    stderr: 'ignore',
  });
  const instance = { port, baseUrl: `http://127.0.0.1:${port}`, process: child };
  await waitUntilReady(instance);
  return instance;
}

async function waitUntilReady(instance: Instance): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (instance.process.exitCode !== null) throw new Error(`instância ${instance.port} morreu no boot`);
    try {
      const res = await fetch(`${instance.baseUrl}/health/ready`);
      if (res.status === 200) return;
    } catch {
      // ainda subindo
    }
    await Bun.sleep(200);
  }
  throw new Error(`instância ${instance.port} não ficou pronta`);
}

// mata sem dar chance de terminar nada, como um crash ou um kill -9
export async function killInstance(instance: Instance): Promise<void> {
  instance.process.kill('SIGKILL');
  await instance.process.exited;
}

export async function request(
  baseUrl: string,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<HttpResult> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
}

// várias instâncias atrás de um "balanceador" que distribui as requisições em rodízio
export class Cluster {
  /** quantas vezes uma requisição teve que ir pra outra instância pq a primeira caiu no meio */
  failovers = 0;

  constructor(public instances: Instance[]) {}

  at(index: number): Instance {
    return this.instances[index % this.instances.length]!;
  }

  replace(index: number, instance: Instance): void {
    this.instances[index] = instance;
  }

  // age como um provedor de verdade: se a instância cair ou responder 503, reenvia pra próxima
  // com a msm Idempotency-Key, até ter uma resposta definitiva
  async submit(body: Record<string, unknown>, startAt: number): Promise<HttpResult> {
    const key = `${body.providerId}:${body.externalTransactionId}`;
    for (let attempt = 0; attempt < 40; attempt++) {
      const instance = this.at(startAt + attempt);
      try {
        const result = await request(instance.baseUrl, 'POST', '/wagering/transactions', body, { 'Idempotency-Key': key });
        if (result.status !== 503) return result;
      } catch {
        // instância caiu no meio da requisição
        this.failovers += 1;
      }
      await Bun.sleep(100);
    }
    throw new Error(`sem resposta definitiva pra ${key}`);
  }
}

export async function waitFor(condition: () => Promise<boolean>, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await Bun.sleep(250);
  }
  throw new Error(`tempo esgotado esperando: ${label}`);
}
