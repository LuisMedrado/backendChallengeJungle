import { describe, expect, it } from 'bun:test';

// testar bun
describe('sanity', () => {
  it('bun test roda', () => {
    expect(1n + 1n).toBe(2n);
  });
});
