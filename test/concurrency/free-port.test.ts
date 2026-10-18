import { describe, expect, it } from 'bun:test';
import { freePort, freePorts } from './support/instances';

describe('freePort', () => {
  it('devolve uma porta que dá pra abrir logo em seguida', async () => {
    const port = await freePort();
    expect(port).toBeGreaterThan(0);

    const server = Bun.serve({ port, hostname: '127.0.0.1', fetch: () => new Response('ok') });
    try {
      expect(server.port).toBe(port);
    } finally {
      server.stop(true);
    }
  });

  it('não devolve uma porta que já tá ocupada', async () => {
    const busy = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('ok') });
    try {
      const ports = await Promise.all(Array.from({ length: 5 }, () => freePort()));
      expect(ports).not.toContain(busy.port);
    } finally {
      busy.stop(true);
    }
  });
});

describe('freePorts', () => {
  it('devolve portas diferentes entre si', async () => {
    const ports = await freePorts(3);
    expect(ports).toHaveLength(3);
    expect(new Set(ports).size).toBe(3);
  });
});
