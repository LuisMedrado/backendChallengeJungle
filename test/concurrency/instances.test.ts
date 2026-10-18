import { describe, expect, it } from 'bun:test';
import { freePorts, startCluster } from './support/instances';

async function answers(port: number): Promise<boolean> {
  try {
    await fetch(`http://127.0.0.1:${port}/health/live`);
    return true;
  } catch {
    return false;
  }
}

describe('startCluster', () => {
  it('se uma instância não sobe, derruba as outras em vez de deixar órfã rodando', async () => {
    // porta ocupada por um impostor que nunca fica pronto: a instância ali ou morre no boot ou estoura o tempo
    const busy = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('ocupada', { status: 503 }) });
    const free = await freePorts(2);
    try {
      const error = await startCluster([busy.port!, ...free], { readyTimeoutMs: 10_000 }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(String(busy.port));
      expect((error as Error).message).toContain('.log');

      for (const port of free) expect(await answers(port)).toBe(false);
    } finally {
      busy.stop(true);
    }
  }, 60_000);
});
