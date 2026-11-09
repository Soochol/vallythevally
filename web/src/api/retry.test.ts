import { expect, test } from "vitest";
import { ApiRequestError } from "./http";
import { pollInterval, retryDelay, shouldRetry } from "./retry";

const NOW = 1_794_182_400_000;
const at = (secondsFromNow: number) => NOW / 1000 + secondsFromNow;
const kiwoom = (resume: ConstructorParameters<typeof ApiRequestError>[2]) => new ApiRequestError("kiwoom_unavailable", "m", resume);

test("서버가 다시 보낼 시각을 주지 않은 실패는 자동으로 다시 보내지 않는다", () => {
  const mismatch = kiwoom({ reason: "symbol_mismatch", retryAt: null, manualActionRequired: false });
  expect(shouldRetry(0, mismatch, NOW)).toBe(false);
  expect(pollInterval(mismatch, 60_000, NOW)).toBe(false);
});

test("사람이 고쳐야 하는 실패는 다시 보내지도, 주기 조회를 잇지도 않는다", () => {
  const stopped = kiwoom({ reason: "unknown_failure", retryAt: null, manualActionRequired: true });
  expect(shouldRetry(0, stopped, NOW)).toBe(false);
  expect(pollInterval(stopped, 60_000, NOW)).toBe(false);
});

test("관문이 열리는 시각이 가까우면 그 시각에 다시 보낸다", () => {
  const gated = kiwoom({ reason: "kiwoom_error", retryAt: at(30), manualActionRequired: false });
  expect(shouldRetry(0, gated, NOW)).toBe(true);
  expect(shouldRetry(2, gated, NOW)).toBe(false);
  expect(retryDelay(0, gated, NOW)).toBe(30_000);
  expect(pollInterval(gated, 60_000, NOW)).toBe(60_000);
});

test("관문이 오래 닫혀 있으면 자동으로 다시 보내지 않고, 주기 조회는 열리는 시각까지 미룬다", () => {
  const long = kiwoom({ reason: "rate_limited", retryAt: at(300), manualActionRequired: false });
  expect(shouldRetry(0, long, NOW)).toBe(false);
  expect(pollInterval(long, 60_000, NOW)).toBe(300_000);
});

test("서버에 닿지 못했을 때만 브라우저가 스스로 다시 보낸다", () => {
  const network = new ApiRequestError("network", "서버에 연결하지 못했습니다");
  expect(shouldRetry(0, network, NOW)).toBe(true);
  expect(shouldRetry(1, network, NOW)).toBe(true);
  expect(shouldRetry(2, network, NOW)).toBe(false);
  expect(pollInterval(network, 60_000, NOW)).toBe(60_000);
  expect(pollInterval(null, 60_000, NOW)).toBe(60_000);
});

test("코드가 kiwoom_unavailable이라는 것만으로는 다시 보내지 않는다", () => {
  expect(shouldRetry(0, new ApiRequestError("kiwoom_unavailable", "옛 서버"), NOW)).toBe(false);
});
