export interface LatencySummary {
  count: number;
  mean: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

// nearest-rank: o menor valor que cobre p% da amostra, sem interpolar
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1]!;
}

export function summarize(values: number[]): LatencySummary {
  const total = values.reduce((sum, value) => sum + value, 0);
  return {
    count: values.length,
    mean: values.length === 0 ? Number.NaN : total / values.length,
    p50: percentile(values, 50),
    p95: percentile(values, 95),
    p99: percentile(values, 99),
    max: values.length === 0 ? Number.NaN : Math.max(...values),
  };
}

// formato texto do prometheus, uma série por linha. chave é o nome com os labels do jeito que vieram
export function parseMetrics(text: string): Map<string, number> {
  const metrics = new Map<string, number>();
  for (const line of text.split('\n')) {
    if (line === '' || line.startsWith('#')) continue;
    const separator = line.lastIndexOf(' ');
    metrics.set(line.slice(0, separator), Number(line.slice(separator + 1)));
  }
  return metrics;
}

export function sumMetric(metrics: Map<string, number>, name: string, labels: Record<string, string> = {}): number {
  let total = 0;
  for (const [key, value] of metrics) {
    if (key !== name && !key.startsWith(`${name}{`)) continue;
    const matches = Object.entries(labels).every(([label, expected]) => key.includes(`${label}="${expected}"`));
    if (matches) total += value;
  }
  return total;
}
