import { TickMarkType, type UTCTimestamp } from "lightweight-charts";
import type { Period } from "../api/generated/Period";
import type { UnixSeconds } from "../api/generated/UnixSeconds";

// 계약의 t는 진짜 Unix 초다. Lightweight Charts는 UTC로 표시하므로 KST 벽시계로 보이게 9시간을 더한다.
// 이 변환은 이 파일에만 둔다(frontend.md §5.4).
const KST_OFFSET = 32400;

export function toChartTime(t: UnixSeconds): UTCTimestamp {
  return (t + KST_OFFSET) as UTCTimestamp;
}

export function fromChartTime(time: UTCTimestamp): UnixSeconds {
  return time - KST_OFFSET;
}

const pad = (n: number) => String(n).padStart(2, "0");

function kstParts(t: UnixSeconds) {
  const d = new Date((t + KST_OFFSET) * 1000);
  const year = String(d.getUTCFullYear());
  const month = `${year}-${pad(d.getUTCMonth() + 1)}`;
  const day = `${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  return { year, month, day, date: `${year}-${day}`, clock: `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}` };
}

export function isIntraday(period: Period): boolean {
  return period !== "D" && period !== "W" && period !== "M";
}

/** 봉 시각. 일·주·월봉은 날짜만, 분봉은 `2026-11-06 19:55`. */
export function formatBarTime(t: UnixSeconds, period: Period): string {
  const { date, clock } = kstParts(t);
  return isIntraday(period) ? `${date} ${clock}` : date;
}

/** 한국 시각 `HH:MM`. */
export function formatKstClock(t: UnixSeconds): string {
  return kstParts(t).clock;
}

/**
 * 분봉 시간축 눈금: 하루 안은 `HH:mm`, 날짜가 바뀌는 눈금은 `11-06`, 달·해가 바뀌면 `2026-11`, `2026`.
 * 일·주·월봉은 null을 돌려 라이브러리 기본 눈금을 쓴다. 눈금 값은 차트 시각(KST 벽시계)이다.
 */
export function formatTickMark(time: UTCTimestamp, type: TickMarkType, period: Period): string | null {
  if (!isIntraday(period)) return null;
  const p = kstParts(fromChartTime(time));
  switch (type) {
    case TickMarkType.Year:
      return p.year;
    case TickMarkType.Month:
      return p.month;
    case TickMarkType.DayOfMonth:
      return p.day;
    case TickMarkType.Time:
    case TickMarkType.TimeWithSeconds:
      return p.clock;
  }
}
