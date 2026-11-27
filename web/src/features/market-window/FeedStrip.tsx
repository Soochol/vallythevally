import { useRef } from "react";
import type { SubErrorCode } from "../../api/generated/SubErrorCode";
import { formatClock } from "./format";

const FEED_REJECTION_TEXT: Readonly<Record<SubErrorCode, string>> = {
  realtime_limit: "실시간 자리가 부족해 호가가 갱신되지 않습니다",
  kiwoom_unavailable: "키움에 연결되지 않아 호가가 갱신되지 않습니다",
  unknown_symbol: "알 수 없는 종목입니다",
  bad_request: "호가를 구독하지 못했습니다",
};

export function feedRejectionText(code: SubErrorCode): string {
  return FEED_REJECTION_TEXT[code];
}

export function feedDownText(since: number | null): string {
  return `실시간 끊김${since !== null ? ` · ${formatClock(Math.floor(since / 1000))}부터` : ""} · 다시 잇는 중`;
}

export function useFeedDownSince(connected: boolean): number | null {
  const since = useRef<number | null>(null);
  if (connected) since.current = null;
  else if (since.current === null) since.current = Date.now();
  return since.current;
}
