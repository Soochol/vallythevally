import type { AccountStatus } from "../../api/generated/AccountStatus";
import type { SyncStatus } from "../../api/generated/SyncStatus";
import type { ConnectionTone } from "./connectionView";

export interface SyncView {
  label: string;
  tone: ConnectionTone;
}

export const SYNC_ERROR_TEXT: Record<string, string> = {
  unreachable: "계정 서버에 닿지 못했습니다",
  rejected: "계정 서버가 문서를 거절했습니다",
  malformed: "받은 문서가 올바르지 않아 적용하지 않았습니다",
  storage: "이 PC에 저장하지 못했습니다",
};

export const syncErrorText = (code: string): string => SYNC_ERROR_TEXT[code] ?? "알 수 없는 오류가 났습니다";

export function syncStatusView(sync: SyncStatus): SyncView {
  if (sync.state === "needs_choice") return { label: "셋업 선택 필요", tone: "amber" };
  if (sync.state === "owner_mismatch") return { label: "이 PC 셋업은 다른 계정 것입니다", tone: "red" };
  if (sync.lastError === "unreachable") {
    return { label: sync.pendingDocuments > 0 ? `올리지 못한 변경 ${sync.pendingDocuments}개 · 계정 서버에 닿지 못함` : "계정 서버에 닿지 못함", tone: "amber" };
  }
  if (sync.refusedDocuments > 0) return { label: `거절된 문서 ${sync.refusedDocuments}개`, tone: "red" };
  if (sync.lastError !== null) return { label: syncErrorText(sync.lastError), tone: "red" };
  if (sync.pendingDocuments > 0) return { label: "올리는 중", tone: "gray" };
  return { label: "동기화됨", tone: "mint" };
}

export function syncView(account: AccountStatus | null): SyncView | null {
  switch (account?.state) {
    case undefined:
    case "local_only":
    case "owner_mismatch":
      return null;
    case "signed_out":
      return { label: "로그인 필요", tone: "red" };
    case "signed_in":
      return syncStatusView(account.sync);
    default: {
      const _exhaustive: never = account;
      return _exhaustive;
    }
  }
}
