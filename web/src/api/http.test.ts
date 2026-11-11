import { afterEach, expect, test, vi } from "vitest";
import { useKiwoomStore } from "../stores/kiwoom";
import { useServerClock } from "../stores/serverClock";
import { ApiRequestError, getJson } from "./http";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  useKiwoomStore.setState({ stopped: null, notice: null });
  useServerClock.setState({ serverAheadMs: 0 });
});

const reply = (status: number, body: unknown) =>
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status })));

test("사람이 고쳐야 하는 실패는 어느 요청에서 오든 연결 상태에 원인과 조치를 남긴다", async () => {
  const message = "키움이 지정단말기 인증 실패([8050])로 거절했습니다. 지금 공인 IP를 키움 포털에 등록하세요";
  const resume = { reason: "auth_blocked", retryAt: null, manualActionRequired: true } as const;
  reply(502, { error: { code: "kiwoom_auth_failed", message, ...resume } });
  await expect(getJson("/api/symbols/005930")).rejects.toEqual(new ApiRequestError("kiwoom_auth_failed", message, resume));
  expect(useKiwoomStore.getState().stopped).toBe(message);
});

test("다시 보낼 수 있는 오류는 연결 상태를 멈춤으로 바꾸지 않는다", async () => {
  reply(503, { error: { code: "kiwoom_unavailable", message: "잠시 뒤", reason: "rate_limited", retryAt: 1, manualActionRequired: false } });
  await expect(getJson("/api/bars")).rejects.toBeInstanceOf(ApiRequestError);
  expect(useKiwoomStore.getState().stopped).toBeNull();
});

test("키움 응답 시간 초과는 상태 줄에 안내를 남기고, 다음 성공에서 지운다", async () => {
  const message = "키움 응답이 15초 안에 오지 않았습니다(ka10095, 응답 대기 단계)";
  reply(503, { error: { code: "kiwoom_unavailable", message, reason: "kiwoom_timeout", retryAt: 1, manualActionRequired: false } });
  await expect(getJson("/api/quotes?symbols=005930")).rejects.toBeInstanceOf(ApiRequestError);
  expect(useKiwoomStore.getState().notice).toBe(message);
  reply(200, []);
  await getJson("/api/quotes?symbols=005930");
  expect(useKiwoomStore.getState().notice).toBeNull();
});

test("오류 본문의 사유, 다시 보낼 시각, 사람 조치 여부를 그대로 읽는다", async () => {
  reply(503, { error: { code: "kiwoom_unavailable", message: "m", reason: "rate_limited", retryAt: 1_794_182_430, manualActionRequired: false } });
  const e = await getJson("/api/quotes?symbols=005930").catch((x: unknown) => x);
  expect(e).toMatchObject({ code: "kiwoom_unavailable", reason: "rate_limited", retryAt: 1_794_182_430, manualActionRequired: false });
});

test("응답의 Date 헤더로 브라우저 시계가 앞서든 뒤처지든 서버의 지금을 안다", async () => {
  const sentAt = Date.parse("2026-11-11T10:42:00+09:00");
  const dated = (status: number, body: unknown) =>
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { Date: new Date(sentAt).toUTCString() } })));
  vi.useFakeTimers({ toFake: ["Date"] });
  for (const browserAheadMs of [60_000, -60_000]) {
    vi.setSystemTime(sentAt + browserAheadMs);
    dated(200, {});
    await getJson("/api/screener/status");
    expect(Date.now() + useServerClock.getState().serverAheadMs).toBe(sentAt);
  }
  vi.setSystemTime(sentAt + 5_000);
  dated(503, { error: { code: "kiwoom_unavailable", message: "m", reason: "rate_limited", retryAt: 1, manualActionRequired: false } });
  await expect(getJson("/api/screener/status")).rejects.toBeInstanceOf(ApiRequestError);
  expect(Date.now() + useServerClock.getState().serverAheadMs).toBe(sentAt);
});

test("Date 헤더가 없는 응답은 앞서 잰 서버 시계를 그대로 둔다", async () => {
  useServerClock.setState({ serverAheadMs: -60_000 });
  reply(200, {});
  await getJson("/api/screener/status");
  expect(useServerClock.getState().serverAheadMs).toBe(-60_000);
});
