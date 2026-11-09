import { afterEach, expect, test, vi } from "vitest";
import { useKiwoomStore } from "../stores/kiwoom";
import { ApiRequestError, getJson } from "./http";

afterEach(() => {
  vi.unstubAllGlobals();
  useKiwoomStore.setState({ authFailure: null });
});

const reply = (status: number, body: unknown) =>
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status })));

test("키움 인증 거절은 어느 요청에서 오든 연결 상태에 원인과 조치를 남긴다", async () => {
  const message = "키움이 지정단말기 인증 실패([8050])로 거절했습니다. 지금 공인 IP를 키움 포털에 등록하세요";
  reply(502, { error: { code: "kiwoom_auth_failed", message } });
  await expect(getJson("/api/symbols/005930")).rejects.toEqual(new ApiRequestError("kiwoom_auth_failed", message));
  expect(useKiwoomStore.getState().authFailure).toBe(message);
});

test("다른 오류는 연결 상태를 건드리지 않는다", async () => {
  reply(503, { error: { code: "kiwoom_unavailable", message: "잠시 뒤" } });
  await expect(getJson("/api/bars")).rejects.toBeInstanceOf(ApiRequestError);
  expect(useKiwoomStore.getState().authFailure).toBeNull();
});
