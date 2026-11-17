import type { ApiRequestError } from "../../api/http";

export const DELETE_PHRASE = "계정 삭제";

export const formatSignedInAt = (seconds: number): string =>
  new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", dateStyle: "medium", timeStyle: "short" }).format(new Date(seconds * 1000));

export function deleteFailureText(error: ApiRequestError | null): string {
  if (error?.code === "account_server_unavailable") return "계정 서버에 닿지 못해 아무것도 지워지지 않았습니다. 잠시 뒤 다시 시도하세요";
  return `${error?.message ?? "계정을 지우지 못했습니다"}. 지워졌는지 알 수 없으면 계정 메뉴를 다시 열어 상태를 확인하세요`;
}

export const lastSyncText = (seconds: number | null): string => (seconds === null ? "아직 없음" : formatSignedInAt(seconds));
