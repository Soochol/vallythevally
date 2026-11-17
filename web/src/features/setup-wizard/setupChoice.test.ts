import { describe, expect, test } from "vitest";
import type { SyncStatus } from "../../api/generated/SyncStatus";
import { choiceText, setupSummary } from "./setupChoice";

const running = (patch: Partial<SyncStatus> = {}): SyncStatus => ({ state: "running", lastSuccessAt: 100, pendingDocuments: 0, refusedDocuments: 0, lastError: null, ...patch }) as SyncStatus;

describe("첫 로그인 셋업 선택", () => {
  test("덮어쓰이는 쪽을 문서 수와 함께 문장으로 적는다", () => {
    expect(choiceText("upload_local", 4, 9)).toMatchObject({ effect: "이 PC의 문서 4개를 계정에 올립니다.", warning: "계정에 있는 셋업 문서 9개는 이 PC 것으로 덮어쓰입니다." });
    expect(choiceText("take_account", 4, 9)).toMatchObject({ effect: "계정의 문서 9개를 이 PC로 받습니다.", warning: "이 PC에 있는 셋업 문서 4개는 계정 것으로 덮어쓰입니다." });
  });

  test("무엇이 일어났는지는 고른 것과 동기화 상태로 정한다", () => {
    const needs = { state: "needs_choice", localDocuments: 4, accountDocuments: 9, lastSuccessAt: null, pendingDocuments: 0, refusedDocuments: 0, lastError: null } as SyncStatus;
    expect(setupSummary(needs, null)).toEqual({ kind: "choose", local: 4, account: 9 });
    expect(setupSummary(running({ lastSuccessAt: null }), null)).toEqual({ kind: "syncing" });
    expect(setupSummary(running({ pendingDocuments: 1 }), "upload_local")).toEqual({ kind: "syncing" });
    expect(setupSummary(running(), "upload_local")).toEqual({ kind: "uploaded" });
    expect(setupSummary(running(), "take_account")).toEqual({ kind: "taken" });
    expect(setupSummary(running(), null)).toEqual({ kind: "matched" });
    expect(setupSummary(running({ lastError: "unreachable" }), null)).toEqual({ kind: "stalled", text: "계정 서버에 닿지 못했습니다" });
  });
});
