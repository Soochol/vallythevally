import type { ApiRequestError } from "../../api/http";
import type { SyncStatus } from "../../api/generated/SyncStatus";
import { formatKstMinute } from "../../chart/time";
import { syncErrorText } from "../status/syncView";

export const DELETE_PHRASE = "계정 삭제";
export const REPLACE_PHRASE = "지우고 바꾸기";

export const formatSignedInAt = (seconds: number): string => formatKstMinute(seconds);

export function deleteFailureText(error: ApiRequestError | null): string {
  if (error?.code === "account_server_unavailable") return "계정 서버에 닿지 못해 아무것도 지워지지 않았습니다. 잠시 뒤 다시 시도하세요";
  return `${error?.message ?? "계정을 지우지 못했습니다"}. 지워졌는지 알 수 없으면 계정 메뉴를 다시 열어 상태를 확인하세요`;
}

export const lastSyncText = (seconds: number | null): string => (seconds === null ? "아직 없음" : formatSignedInAt(seconds));

export type SyncBand = { kind: "synced" } | { kind: "uploading" } | { kind: "error"; text: string };

export function syncProblemText(lastError: string, pendingDocuments: number): string {
  if (lastError === "unreachable") return pendingDocuments > 0 ? `계정 서버에 닿지 못해 변경 ${pendingDocuments}개를 올리지 못했습니다` : syncErrorText(lastError);
  return pendingDocuments > 0 ? `${syncErrorText(lastError)} · 올리지 못한 변경 ${pendingDocuments}개` : syncErrorText(lastError);
}

export function syncBand(sync: SyncStatus): SyncBand {
  if (sync.lastError !== null) return { kind: "error", text: syncProblemText(sync.lastError, sync.pendingDocuments) };
  return sync.pendingDocuments > 0 ? { kind: "uploading" } : { kind: "synced" };
}
