import { ApiRequestError } from "./http";

/** 서버가 준 시각까지 이보다 오래 기다려야 하면 자동으로 다시 보내지 않는다. 화면이 그 시각을 보여 준다. */
const MAX_AUTO_WAIT_MS = 60_000;
const MAX_AUTO_RETRIES = 2;
const NETWORK_BACKOFF_MS = 1_000;

/** 브라우저가 스스로 다시 보내기까지 기다릴 시간. 다시 보내면 안 되면 null. */
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

/** 주기 조회의 다음 간격. 마지막 실패가 다시 보내면 안 되는 것이면 멈추고, 관문 시각이 있으면 그때까지 미룬다. */
export function pollInterval(error: unknown, normalMs: number, now = Date.now()): number | false {
  if (!(error instanceof ApiRequestError) || error.code === "network") return normalMs;
  if (error.manualActionRequired || error.retryAt === null) return false;
  return Math.max(normalMs, error.retryAt * 1000 - now);
}
