import { afterEach, expect, test, vi } from "vitest";
import { useKiwoomStore } from "../stores/kiwoom";
import { serverNow, useServerClock } from "../stores/serverClock";
import { ApiRequestError, getJson } from "./http";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  useKiwoomStore.setState({ stopped: null, notice: null });
  useServerClock.setState({ serverTimeOrigin: null });
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

const sentAt = Date.parse("2026-11-11T10:42:00+09:00");
const serverNowSeen = () => serverNow(useServerClock.getState().serverTimeOrigin);
const dated = (date: number, status = 200, body: unknown = {}) =>
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { Date: new Date(date).toUTCString() } })));

test("응답의 Date 헤더로 브라우저 시계가 앞서든 뒤처지든 서버의 지금을 안다", async () => {
  vi.useFakeTimers({ toFake: ["Date", "performance"] });
  for (const browserAheadMs of [60_000, -60_000]) {
    useServerClock.setState({ serverTimeOrigin: null });
    vi.setSystemTime(sentAt + browserAheadMs);
    dated(sentAt);
    await getJson("/api/screener/status");
    expect(serverNowSeen()).toBe(sentAt);
  }
  useServerClock.setState({ serverTimeOrigin: null });
  dated(sentAt, 503, { error: { code: "kiwoom_unavailable", message: "m", reason: "rate_limited", retryAt: 1, manualActionRequired: false } });
  await expect(getJson("/api/screener/status")).rejects.toBeInstanceOf(ApiRequestError);
  expect(serverNowSeen()).toBe(sentAt);
});

test("늦게 온 옛 응답은 서버의 지금을 뒤로 돌리지 않고, 서버의 지금은 흐른 시간만큼 나아간다", async () => {
  vi.useFakeTimers({ toFake: ["Date", "performance"] });
  dated(sentAt);
  await getJson("/api/screener/status");
  vi.advanceTimersByTime(30_000);
  dated(sentAt - 20_000);
  await getJson("/api/bars");
  expect(serverNowSeen()).toBe(sentAt + 30_000);
  dated(sentAt + 31_000);
  await getJson("/api/symbols?q=a");
  expect(serverNowSeen()).toBe(sentAt + 31_000);
});

test("브라우저 벽시계를 바꿔도 서버의 지금은 그대로 흐른다", async () => {
  vi.useFakeTimers({ toFake: ["Date", "performance"] });
  vi.setSystemTime(sentAt);
  dated(sentAt);
  await getJson("/api/screener/status");
  vi.setSystemTime(sentAt - 3_600_000);
  vi.advanceTimersByTime(1_000);
  expect(serverNowSeen()).toBe(sentAt + 1_000);
  vi.setSystemTime(sentAt + 3_600_000);
  expect(serverNowSeen()).toBe(sentAt + 1_000);
});

test("Date 헤더가 없는 응답은 서버의 지금을 바꾸지 않고, 표본이 하나도 없으면 브라우저 시계를 쓴다", async () => {
  vi.useFakeTimers({ toFake: ["Date", "performance"] });
  vi.setSystemTime(sentAt);
  reply(200, {});
  await getJson("/api/screener/status");
  expect(serverNowSeen()).toBe(sentAt);
  dated(sentAt - 60_000);
  await getJson("/api/screener/status");
  reply(200, {});
  await getJson("/api/screener/status");
  expect(serverNowSeen()).toBe(sentAt - 60_000);
});
