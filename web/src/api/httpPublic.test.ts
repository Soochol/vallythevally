import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { useServerModeStore } from "../public-mode/serverMode";
import { useAccountStore } from "../stores/account";
import { useServerClock } from "../stores/serverClock";
import { ApiRequestError, getJson } from "./http";

const SERVER_NOW_MS = Date.parse("2026-11-09T10:00:00+09:00");

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", Date: new Date(SERVER_NOW_MS).toUTCString() } });
const failure = (code: string, retryAt?: number) => ({ error: { code, message: "실패", ...(retryAt === undefined ? {} : { retryAt }) } });

beforeEach(() => {
  useServerModeStore.setState({ kind: "public" });
  useAccountStore.setState({ status: { state: "signed_in", provider: "google", accountId: "", signedInAt: 1, sync: { state: "running", lastSuccessAt: null, pendingDocuments: 0, refusedDocuments: 0, lastError: null } }, pushes: 0 });
  useServerClock.setState({ serverTimeOrigin: null });
});

afterEach(() => {
  vi.unstubAllGlobals();
  useServerModeStore.setState({ kind: "local" });
});

describe("공개 모드의 요청", () => {
  test("401 signed_out이면 계정 상태가 로그아웃으로 바뀐다", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(401, failure("signed_out"))));
    await expect(getJson("/api/watchlists")).rejects.toMatchObject({ code: "signed_out" });
    expect(useAccountStore.getState().status).toEqual({ state: "signed_out" });
  });

  test("로컬 모드에서는 401이어도 계정 상태를 바꾸지 않는다", async () => {
    useServerModeStore.setState({ kind: "local" });
    vi.stubGlobal("fetch", vi.fn(async () => json(401, failure("signed_out"))));
    await expect(getJson("/api/watchlists")).rejects.toBeInstanceOf(ApiRequestError);
    expect(useAccountStore.getState().status?.state).toBe("signed_in");
  });

  test("429의 retryAt이 지나기 전에는 같은 요청을 서버로 보내지 않는다", async () => {
    const retryAt = SERVER_NOW_MS / 1000 + 3_600;
    const send = vi.fn(async () => json(429, failure("internal", retryAt)));
    vi.stubGlobal("fetch", send);
    await expect(getJson("/api/rankings-hold")).rejects.toMatchObject({ retryAt });
    await expect(getJson("/api/rankings-hold")).rejects.toMatchObject({ retryAt });
    expect(send).toHaveBeenCalledTimes(1);
  });

  test("retryAt이 이미 지났으면 다시 보낸다", async () => {
    const send = vi.fn(async () => json(503, failure("internal", SERVER_NOW_MS / 1000 - 5)));
    vi.stubGlobal("fetch", send);
    await expect(getJson("/api/hold-expired")).rejects.toBeInstanceOf(ApiRequestError);
    await expect(getJson("/api/hold-expired")).rejects.toBeInstanceOf(ApiRequestError);
    expect(send).toHaveBeenCalledTimes(2);
  });

  test("로컬 모드는 retryAt이 있어도 막지 않는다", async () => {
    useServerModeStore.setState({ kind: "local" });
    const send = vi.fn(async () => json(429, failure("internal", SERVER_NOW_MS / 1000 + 3_600)));
    vi.stubGlobal("fetch", send);
    await expect(getJson("/api/local-hold")).rejects.toBeInstanceOf(ApiRequestError);
    await expect(getJson("/api/local-hold")).rejects.toBeInstanceOf(ApiRequestError);
    expect(send).toHaveBeenCalledTimes(2);
  });
});
