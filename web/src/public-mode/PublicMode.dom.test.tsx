// @vitest-environment happy-dom
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, test } from "vitest";
import type { KiwoomKeyList } from "../api/generated/KiwoomKeyList";
import { takeLoginFailure } from "../features/account/loginFailure";
import { useAccountStore } from "../stores/account";
import { useKiwoomLinkStore } from "../stores/kiwoomLink";
import { useSelectionStore } from "../stores/selection";
import { resetDomAfterEach } from "../test/domSetup";
import { renderWithProviders, stubFetch } from "../test/domHarness";
import { getJson } from "../api/http";
import { PublicSystemSettings } from "./PublicSystemSettings";
import { PublicUnavailable } from "./PublicUnavailable";
import { useServerModeStore } from "./serverMode";

const SESSION = { provider: "google" as const, createdAt: Math.floor(Date.now() / 1000) - 600 };

beforeEach(() => {
  useServerModeStore.setState({ kind: "public" });
  useSelectionStore.setState({ dialog: null, toasts: [], toast: null });
  useKiwoomLinkStore.setState({ status: null });
  useAccountStore.setState({
    status: {
      state: "signed_in",
      provider: SESSION.provider,
      accountId: "user-1",
      signedInAt: SESSION.createdAt,
      sync: { state: "running", lastSuccessAt: SESSION.createdAt, pendingDocuments: 0, refusedDocuments: 0, lastError: null },
    },
  });
});

resetDomAfterEach();

test("로그인 실패 4종 reason은 안내 문구를 만들고 URL 질의를 지운다", () => {
  const cases = [
    ["cancelled", "로그인을 취소했습니다"],
    ["idp_failed", "Google 또는 네이버가 로그인을 마치지 못했습니다"],
    ["account_limit", "새 계정을 더 받지 않습니다"],
    ["blocked", "이 계정은 쓸 수 없습니다"],
  ] as const;
  for (const [reason, expected] of cases) {
    const taken = takeLoginFailure(new URL(`http://127.0.0.1:8080/?login=error&reason=${reason}`));
    expect(taken?.text).toContain(expected);
    expect(taken?.cleaned).toBe("/");
  }
});

test("공개 불가 창과 공개 시스템 설정은 키움 키 탭 없이 단축키 탭으로 열리고 키움 API를 부르지 않는다", async () => {
  const api = stubFetch(({ pathname }) => {
    if (pathname === "/api/collector/access") return { body: { access: "denied" } };
    if (pathname === "/api/system/kiwoom/keys") return { body: { keys: [], limit: 5, keyFileProblem: null } satisfies KiwoomKeyList };
    return { body: {} };
  });

  const { client } = renderWithProviders(
    <>
      <PublicUnavailable />
      <PublicSystemSettings menu={null} />
    </>,
  );

  expect(screen.getByTestId("public-unavailable").textContent).toContain("실시간·차트 연결은 준비 중입니다");
  expect(screen.getByRole("tab", { name: "단축키" }).getAttribute("aria-selected")).toBe("true");
  expect(screen.queryByRole("tab", { name: "증권사 · 계좌" })).toBeNull();
  expect(screen.queryByRole("tab", { name: "일반" })).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(api.calls.filter((c) => c.pathname.startsWith("/api/system/kiwoom"))).toEqual([]);
  client.clear();
});

test("공개 계정 메뉴에서 로그아웃 POST 및 확인 입력 후 계정 삭제 DELETE 요청을 보낸다", async () => {
  const api = stubFetch(({ pathname }) => {
    if (pathname === "/api/collector/access") return { body: { access: "denied" } };
    if (pathname === "/v1/session/logout") return { body: {} };
    if (pathname === "/v1/account") return { body: {} };
    return { body: {} };
  });

  const { client } = renderWithProviders(<PublicSystemSettings menu="account" />);
  expect(screen.getByText("Google")).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "계정 삭제" }));
  const confirm = screen.getByRole("region", { name: "계정 삭제" });
  expect(confirm.textContent).toContain("계정 서버에 있는 이 계정과 올려 둔 셋업을 지웁니다");
  expect(api.callsTo("DELETE", "/v1/account")).toHaveLength(0);

  fireEvent.change(confirm.querySelector("input")!, { target: { value: "계정 삭제" } });
  fireEvent.click(screen.getByRole("button", { name: "계정 삭제 실행" }));
  await waitFor(() => expect(api.callsTo("DELETE", "/v1/account")).toHaveLength(1));
  expect(api.callsTo("DELETE", "/v1/account")[0]!.headers.get("content-type")).toContain("application/json");
  expect(useAccountStore.getState().status).toEqual({ state: "signed_out" });

  useAccountStore.setState({
    status: {
      state: "signed_in",
      provider: SESSION.provider,
      accountId: "user-1",
      signedInAt: SESSION.createdAt,
      sync: { state: "running", lastSuccessAt: SESSION.createdAt, pendingDocuments: 0, refusedDocuments: 0, lastError: null },
    },
  });
  fireEvent.click(await screen.findByRole("button", { name: "로그아웃" }));
  await waitFor(() => expect(api.callsTo("POST", "/v1/session/logout")).toHaveLength(1));
  expect(api.callsTo("POST", "/v1/session/logout")[0]!.headers.get("content-type")).toContain("application/json");
  expect(useAccountStore.getState().status).toEqual({ state: "signed_out" });
  client.clear();
});

test("공개 모드에서 401 signed_out 응답은 세션을 로그아웃 상태로 바꾸고 429 retryAt 전 재요청은 막는다", async () => {
  const futureRetryAt = Math.floor(Date.now() / 1000) + 30;
  let attempts = 0;
  const api = stubFetch(({ pathname }) => {
    if (pathname === "/api/rankings") {
      attempts++;
      return {
        status: 429,
        body: { error: { code: "kiwoom_unavailable", message: "잠시 뒤 다시 시도하세요", reason: "rate_limited", retryAt: futureRetryAt, manualActionRequired: false } },
      };
    }
    if (pathname === "/api/watchlists") {
      return { status: 401, body: { error: { code: "signed_out", message: "로그아웃됨", reason: null, retryAt: null, manualActionRequired: false } } };
    }
    return { body: {} };
  });

  await expect(getJson("/api/rankings?hold=public-mode-test")).rejects.toMatchObject({ retryAt: futureRetryAt });
  await expect(getJson("/api/rankings?hold=public-mode-test")).rejects.toMatchObject({ retryAt: futureRetryAt });
  expect(attempts).toBe(1);

  await expect(getJson("/api/watchlists")).rejects.toMatchObject({ code: "signed_out" });
  expect(useAccountStore.getState().status).toEqual({ state: "signed_out" });
  expect(api.callsTo("GET", "/api/watchlists")).toHaveLength(1);
});
