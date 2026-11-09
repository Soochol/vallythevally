import { ApiRequestError } from "./http";

const MAX_AUTO_WAIT_MS = 60_000;
const MAX_AUTO_RETRIES = 2;
const NETWORK_BACKOFF_MS = 1_000;

function autoWaitMs(error: unknown, attempt: number, now: number): number | null {
  if (!(error instanceof ApiRequestError)) return null;
  if (error.code === "network") return NETWORK_BACKOFF_MS * 2 ** attempt;
  if (error.manualActionRequired || error.retryAt === null) return null;
  const wait = Math.max(0, error.retryAt * 1000 - now);
  return wait <= MAX_AUTO_WAIT_MS ? wait : null;
}

export function shouldRetry(failureCount: number, error: unknown, now = Date.now()): boolean {
  return failureCount < MAX_AUTO_RETRIES && autoWaitMs(error, failureCount, now) !== null;
}

export function retryDelay(failureCount: number, error: unknown, now = Date.now()): number {
  return autoWaitMs(error, failureCount, now) ?? 0;
}

export function pollInterval(error: unknown, normalMs: number, now = Date.now()): number | false {
  if (!(error instanceof ApiRequestError) || error.code === "network") return normalMs;
  if (error.manualActionRequired || error.retryAt === null) return false;
  return Math.max(normalMs, error.retryAt * 1000 - now);
}
