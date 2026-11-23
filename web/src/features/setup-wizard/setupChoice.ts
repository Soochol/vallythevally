import type { InitialSyncChoice } from "../../api/generated/InitialSyncChoice";
import type { SyncStatus } from "../../api/generated/SyncStatus";
import { syncErrorText } from "../status/syncView";

export interface ChoiceText {
  title: string;
  effect: string;
  warning: string;
  keeps: string;
  loses: string;
  confirm: string;
}

export function choiceText(choice: InitialSyncChoice, local: number, account: number): ChoiceText {
  return choice === "upload_local"
    ? {
        title: "이 PC 셋업 올리기",
        effect: `이 PC의 문서 ${local}개를 계정에 올립니다.`,
        warning: `계정에 있는 셋업 문서 ${account}개는 이 PC 것으로 덮어쓰입니다.`,
        keeps: `이 PC의 문서 ${local}개`,
        loses: `계정의 문서 ${account}개`,
        confirm: "이 PC 셋업으로 덮어쓰기",
      }
    : {
        title: "계정 셋업 받기",
        effect: `계정의 문서 ${account}개를 이 PC로 받습니다.`,
        warning: `이 PC에 있는 셋업 문서 ${local}개는 계정 것으로 덮어쓰입니다.`,
        keeps: `계정의 문서 ${account}개`,
        loses: `이 PC의 문서 ${local}개`,
        confirm: "계정 셋업으로 덮어쓰기",
      };
}

export type SetupSummary =
  | { kind: "choose"; local: number; account: number }
  | { kind: "syncing" }
  | { kind: "uploaded" }
  | { kind: "taken" }
  | { kind: "matched" }
  | { kind: "stalled"; text: string };

export function setupSummary(sync: SyncStatus, chosen: InitialSyncChoice | null): SetupSummary {
  if (sync.state === "needs_choice") return { kind: "choose", local: sync.localDocuments, account: sync.accountDocuments };
  if (sync.state === "owner_mismatch") return { kind: "stalled", text: "이 PC의 셋업은 다른 계정 것입니다." };
  if (sync.lastError !== null) return { kind: "stalled", text: syncErrorText(sync.lastError) };
  if (sync.lastSuccessAt === null || sync.pendingDocuments > 0) return { kind: "syncing" };
  if (chosen === "upload_local") return { kind: "uploaded" };
  if (chosen === "take_account") return { kind: "taken" };
  return { kind: "matched" };
}

export const SUMMARY_TEXT = {
  syncing: "계정과 셋업을 맞추는 중입니다.",
  uploaded: "이 PC의 셋업을 계정에 올렸습니다.",
  taken: "계정의 셋업을 이 PC로 받았습니다.",
  matched: "이 PC의 셋업이 계정과 이미 맞습니다.",
} as const;
