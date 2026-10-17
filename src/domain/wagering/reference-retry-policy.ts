
// Backoff exponencial para transações PENDING_REFERENCE limitado a 5 min
export const REFERENCE_MAX_ATTEMPTS = 10;
const REFERENCE_BASE_DELAY_MS = 2_000;
const REFERENCE_MAX_DELAY_MS = 5 * 60_000;

export function referenceRetryDelayMs(attempt: number): number {
  return Math.min(REFERENCE_BASE_DELAY_MS * 2 ** (attempt - 1), REFERENCE_MAX_DELAY_MS);
}
