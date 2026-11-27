import type { UnixSeconds } from "../../api/generated/UnixSeconds";
import { toChartTime } from "../../chart/time";

const pad2 = (value: number): string => String(value).padStart(2, "0");

export const REPLAY_LIVE_TEXT = "실시간 · 차트를 가리키면 그 시각 호가";
export const REPLAY_VENUE_TITLE = "수집 호가는 통합 시세입니다";

export function formatReplayAt(at: UnixSeconds): string {
  const date = new Date(toChartTime(at) * 1000);
  return `${pad2(date.getUTCMonth() + 1)}/${pad2(date.getUTCDate())} ${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())}:${pad2(date.getUTCSeconds())}`;
}
