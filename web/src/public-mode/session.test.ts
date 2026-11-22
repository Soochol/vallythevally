import { describe, expect, test } from "vitest";
import { ApiRequestError } from "../api/http";
import { loginStartPath, readSession, SESSION_PATH, statusOfSession } from "./session";

const reply = (status: number, body: unknown = null) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe("세션 응답을 계정 상태로 바꾼다", () => {
  test("provider와 만든 시각이 있으면 로그인한 상태다", () => {
    expect(statusOfSession({ provider: "naver", createdAt: 1_762_650_000 })).toMatchObject({ state: "signed_in", provider: "naver", signedInAt: 1_762_650_000 });
  });

  test("모르는 provider나 빠진 값은 받지 않는다", () => {
    expect(statusOfSession({ provider: "kakao", createdAt: 1 })).toBeNull();
    expect(statusOfSession({ provider: "google" })).toBeNull();
    expect(statusOfSession(null)).toBeNull();
  });
});

describe("로그인 상태 읽기", () => {
  test("200이면 로그인한 상태", async () => {
    expect((await readSession(reply(200, { provider: "google", createdAt: 5 }))).state).toBe("signed_in");
  });

  test("401이면 로그아웃 상태로 보고 던지지 않는다", async () => {
    expect(await readSession(reply(401, { error: { code: "signed_out", message: "x" } }))).toEqual({ state: "signed_out" });
  });

  test("그 밖의 실패와 이상한 본문은 던진다", async () => {
    await expect(readSession(reply(503))).rejects.toBeInstanceOf(ApiRequestError);
    await expect(readSession(reply(200, { provider: "x" }))).rejects.toBeInstanceOf(ApiRequestError);
  });

  test("세션 경로를 GET으로 부른다", async () => {
    const calls: Array<[RequestInfo | URL, RequestInit | undefined]> = [];
    await readSession((async (input: RequestInfo | URL, init?: RequestInit) => { calls.push([input, init]); return new Response("{}", { status: 401 }); }) as typeof fetch);
    expect(calls).toEqual([[SESSION_PATH, expect.objectContaining({ method: "GET" })]]);
  });
});

test("로그인 시작 경로는 provider마다 하나다", () => {
  expect(loginStartPath("google")).toBe("/v1/session/google/start");
  expect(loginStartPath("naver")).toBe("/v1/session/naver/start");
});
