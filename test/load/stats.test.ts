import { describe, expect, it } from 'bun:test';
import { parseMetrics, percentile, sumMetric, summarize } from './stats';

describe('percentile', () => {
  it('usa nearest-rank e não depende da ordem de entrada', () => {
    const values = [5, 1, 4, 2, 3, 10, 9, 8, 7, 6];
    expect(percentile(values, 50)).toBe(5);
    expect(percentile(values, 95)).toBe(10);
    expect(percentile(values, 10)).toBe(1);
  });

  it('com um valor só, todo percentil é ele', () => {
    expect(percentile([42], 99)).toBe(42);
  });

  it('lista vazia não tem percentil', () => {
    expect(percentile([], 50)).toBeNaN();
  });
});

describe('summarize', () => {
  it('devolve contagem, média, p50, p95, p99 e máximo', () => {
    const latencies = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(summarize(latencies)).toEqual({ count: 100, mean: 50.5, p50: 50, p95: 95, p99: 99, max: 100 });
  });
});

describe('parseMetrics', () => {
  const text = [
    '# HELP wagering_lock_conflicts_total disputas',
    '# TYPE wagering_lock_conflicts_total counter',
    'wagering_lock_conflicts_total{type="lock_timeout"} 3',
    'wagering_lock_conflicts_total{type="version_mismatch"} 1',
    'wagering_outbox_lag_seconds 0.25',
    'wagering_transactions_total{channel="http",kind="BET",status="PROCESSED"} 120',
    '',
  ].join('\n');

  it('lê cada série com os labels e ignora comentário e linha vazia', () => {
    const metrics = parseMetrics(text);
    expect(metrics.size).toBe(4);
    expect(metrics.get('wagering_outbox_lag_seconds')).toBe(0.25);
    expect(metrics.get('wagering_lock_conflicts_total{type="lock_timeout"}')).toBe(3);
  });

  it('soma uma métrica em todos os labels ou só nos que batem com o filtro', () => {
    const metrics = parseMetrics(text);
    expect(sumMetric(metrics, 'wagering_lock_conflicts_total')).toBe(4);
    expect(sumMetric(metrics, 'wagering_lock_conflicts_total', { type: 'lock_timeout' })).toBe(3);
    expect(sumMetric(metrics, 'wagering_transactions_total', { status: 'PROCESSED' })).toBe(120);
    expect(sumMetric(metrics, 'nao_existe')).toBe(0);
  });
});
