import { beforeEach, describe, expect, test } from "vitest";
import { useAccountStore } from "../stores/account";
import { useServerModeStore } from "./serverMode";
import { markSignedOut, reportSignedOut } from "./signedOut";

const SIGNED_IN = { state: "signed_in", provider: "google", accountId: "", signedInAt: 1, sync: { state: "running", lastSuccessAt: null, pendingDocuments: 0, refusedDocuments: 0, lastError: null } } as const;

beforeEach(() => {
  useServerModeStore.setState({ kind: "public" });
  useAccountStore.setState({ status: SIGNED_IN, pushes: 0 });
});

describe("로그인한 동안 401 signed_out", () => {
  test("공개 모드에서는 로그아웃 상태가 되어 랜딩으로 돌아간다", () => {
    reportSignedOut();
    expect(useAccountStore.getState().status).toEqual({ state: "signed_out" });
  });

  test("로컬 모드에서는 계정 상태를 건드리지 않는다", () => {
    useServerModeStore.setState({ kind: "local" });
    reportSignedOut();
    expect(useAccountStore.getState().status).toEqual(SIGNED_IN);
  });

  test("이미 로그아웃이면 다시 알리지 않는다", () => {
    markSignedOut();
    markSignedOut();
    expect(useAccountStore.getState().pushes).toBe(1);
  });
});
