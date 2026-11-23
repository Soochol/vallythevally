import { describe, expect, test } from "vitest";
import type { SyncStatus } from "../../api/generated/SyncStatus";
import { formatSignedInAt, lastSyncText, syncBand, syncProblemText } from "./accountMenu";

const running = (patch: Partial<SyncStatus> = {}): SyncStatus => ({ state: "running", lastSuccessAt: 100, pendingDocuments: 0, refusedDocuments: 0, lastError: null, ...patch }) as SyncStatus;

describe("계정 메뉴 동기화 표시", () => {
  test("시각은 한국 시각 YYYY-MM-DD HH:MM으로 적는다", () => {
    expect(formatSignedInAt(1_762_650_000)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    expect(lastSyncText(null)).toBe("아직 없음");
  });

  test("상태 띠는 오류가 있으면 원인 문장을, 올릴 것이 있으면 올리는 중을, 아니면 동기화됨을 보인다", () => {
    expect(syncBand(running())).toEqual({ kind: "synced" });
    expect(syncBand(running({ pendingDocuments: 2 }))).toEqual({ kind: "uploading" });
    expect(syncBand(running({ pendingDocuments: 2, lastError: "unreachable" }))).toEqual({ kind: "error", text: "계정 서버에 닿지 못해 변경 2개를 올리지 못했습니다" });
  });

  test("원인 문장은 오류 종류마다 다르고 올리지 못한 변경 수를 붙인다", () => {
    expect(syncProblemText("unreachable", 0)).toBe("계정 서버에 닿지 못했습니다");
    expect(syncProblemText("rejected", 1)).toBe("계정 서버가 문서를 거절했습니다 · 올리지 못한 변경 1개");
    expect(syncProblemText("storage", 0)).toBe("이 PC에 저장하지 못했습니다");
  });
});
