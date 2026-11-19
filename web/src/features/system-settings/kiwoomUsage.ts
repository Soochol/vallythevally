import type { KiwoomUsage } from "../../api/generated/KiwoomUsage";
import type { KiwoomUsageTr } from "../../api/generated/KiwoomUsageTr";
import { formatKstClock } from "../../chart/time";

export const USAGE_REFRESH_MS = 10_000;

const TR_MEANINGS: Readonly<Record<string, string>> = {
  ka10095: "현재가·당일 요약",
  ka10075: "미체결",
  ka10003: "체결",
  kt00018: "잔고",
  kt00007: "체결내역",
  kt00010: "주문가능",
  kt00011: "주문가능",
  ka10080: "분봉",
  ka10081: "일봉",
  ka00001: "계좌 확인",
  ka10004: "호가",
  ka10001: "기본정보",
  ka10032: "순위",
  kt10000: "매수 주문",
  kt10001: "매도 주문",
  kt10002: "정정 주문",
  kt10003: "취소 주문",
};

export const HIT_LIMIT_LABEL = "한도에 닿음";
export const RATE_LIMITED_LABEL = "제한 응답 있음";
export const NO_ROWS_MESSAGE = "지난 1분에 보낸 키움 조회가 없습니다";
export const FIRST_MINUTE_MESSAGE = "1분 뒤부터 보입니다";

export interface UsageRowView {
  apiId: string;
  meaning: string | null;
  sent: number;
  peak: string;
  maxWait: string;
  rateLimited: number;
  hitLimit: boolean;
  warning: boolean;
}

export interface UsageView {
  lastMinute: string;
  totalRateLimited: number;
  rows: UsageRowView[];
  emptyMessage: string | null;
}

export function formatMillis(ms: number): string {
  return `${ms.toLocaleString("en-US")}ms`;
}

export function rowView(tr: KiwoomUsageTr): UsageRowView {
  const { lastMinute } = tr;
  return {
    apiId: tr.apiId,
    meaning: TR_MEANINGS[tr.apiId] ?? null,
    sent: lastMinute.sent,
    peak: `${lastMinute.maxPerSecond} / ${tr.limit}`,
    maxWait: formatMillis(lastMinute.maxWaitMs),
    rateLimited: lastMinute.rateLimited,
    hitLimit: lastMinute.maxPerSecond >= tr.limit && lastMinute.maxWaitMs > 0,
    warning: lastMinute.rateLimited > 0 || tr.totalRateLimited > 0,
  };
}

export function usageView(usage: KiwoomUsage): UsageView {
  const rows = usage.trs.map(rowView);
  const startedAt = usage.lastMinuteStartedAt;
  return {
    lastMinute: startedAt === null ? "아직 없음" : formatKstClock(startedAt),
    totalRateLimited: usage.totalRateLimited,
    rows,
    emptyMessage: rows.length > 0 ? null : startedAt === null ? FIRST_MINUTE_MESSAGE : NO_ROWS_MESSAGE,
  };
}
