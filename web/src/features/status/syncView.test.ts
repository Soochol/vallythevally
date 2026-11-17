import { describe, expect, test } from "vitest";
import type { AccountStatus } from "../../api/generated/AccountStatus";
import type { SyncStatus } from "../../api/generated/SyncStatus";
import { syncStatusView, syncView } from "./syncView";

const running = (patch: Partial<SyncStatus> = {}): SyncStatus => ({ state: "running", lastSuccessAt: 100, pendingDocuments: 0, refusedDocuments: 0, lastError: null, ...patch }) as SyncStatus;
const signedIn = (sync: SyncStatus): AccountStatus => ({ state: "signed_in", provider: "google", accountId: "0123456789abcdef0123", signedInAt: 1, sync });

describe("동기화 표시 문장", () => {
  test.each([
    ["다 올라감", running(), "동기화됨", "mint"],
    ["올리는 중", running({ pendingDocuments: 2 }), "올리는 중", "gray"],
    ["서버에 닿지 못해 쌓임", running({ pendingDocuments: 3, lastError: "unreachable" }), "올리지 못한 변경 3개 · 계정 서버에 닿지 못함", "amber"],
    ["서버에 닿지 못했지만 쌓인 것 없음", running({ lastError: "unreachable" }), "계정 서버에 닿지 못함", "amber"],
    ["거절된 문서", running({ refusedDocuments: 2 }), "거절된 문서 2개", "red"],
    ["서버에 닿지 못함이 거절보다 먼저", running({ refusedDocuments: 2, lastError: "unreachable" }), "계정 서버에 닿지 못함", "amber"],
    ["저장 오류", running({ lastError: "storage" }), "이 PC에 저장하지 못했습니다", "red"],
    ["알 수 없는 오류 코드", running({ lastError: "weird" }), "알 수 없는 오류가 났습니다", "red"],
    ["첫 로그인 선택 대기", { state: "needs_choice", localDocuments: 1, accountDocuments: 2, lastSuccessAt: null, pendingDocuments: 0, refusedDocuments: 0, lastError: null } as SyncStatus, "셋업 선택 필요", "amber"],
  ] as const)("%s", (_name, sync, label, tone) => {
    expect(syncStatusView(sync)).toEqual({ label, tone });
  });

  test("로컬 전용과 상태를 모를 때는 표시가 없고, 로그인 안 함은 로그인 필요다", () => {
    expect(syncView(null)).toBeNull();
    expect(syncView({ state: "local_only" })).toBeNull();
    expect(syncView({ state: "signed_out" })).toEqual({ label: "로그인 필요", tone: "red" });
    expect(syncView(signedIn(running()))?.label).toBe("동기화됨");
  });
});
