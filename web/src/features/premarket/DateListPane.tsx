import { useMemo } from "react";
import type { PreMarketDaySeries } from "../../api/generated/PreMarketDaySeries";
import {
  formatKoreanWeekday,
  formatShortDate,
  formatSignedPct,
  groupDatesByWeek,
  kstTodayYyyymmdd,
  pointVolumeValue,
  valueTone,
  type CompareRange,
  type VolumeUnit,
} from "./logic";

interface DateListPaneProps {
  readonly rangeDates: readonly string[];
  readonly series: readonly PreMarketDaySeries[];
  readonly focusDate: string | null;
  readonly pinnedDates: readonly string[];
  readonly spotDate: string | null;
  readonly range: CompareRange;
  readonly unit: VolumeUnit;
  readonly onSpotDate: (date: string | null) => void;
  readonly onTogglePin: (date: string) => void;
  readonly onSelectFocus: (date: string) => void;
}

export function DateListPane({
  rangeDates,
  series,
  focusDate,
  pinnedDates,
  spotDate,
  range,
  unit,
  onSpotDate,
  onTogglePin,
  onSelectFocus,
}: DateListPaneProps) {
  const seriesByDate = useMemo(() => {
    const map = new Map<string, PreMarketDaySeries>();
    for (const item of series) map.set(item.date, item);
    return map;
  }, [series]);

  const datesDescending = useMemo(() => [...rangeDates].reverse(), [rangeDates]);
  const groups = useMemo(() => groupDatesByWeek(datesDescending), [datesDescending]);
  const todayStr = kstTodayYyyymmdd();

  const maxDayVol = useMemo(() => {
    let peak = 0;
    for (const date of rangeDates) {
      const day = seriesByDate.get(date);
      const last = day?.points[day.points.length - 1];
      if (!last) continue;
      const v = pointVolumeValue(last, unit);
      if (v > peak) peak = v;
    }
    return Math.max(1, peak);
  }, [rangeDates, seriesByDate, unit]);

  return (
    <aside
      className="pm-side"
      data-testid="premarket-date-list"
      onPointerLeave={() => onSpotDate(null)}
      onMouseLeave={() => onSpotDate(null)}
    >
      <div className="pm-side-head">
        <span>최근 {range}일</span>
        <span>등락</span>
      </div>
      <div className="pm-side-list" role="list" aria-label="장전 비교 날짜 목록">
        {groups.map((group) => (
          <div key={group.key} className="pm-week-group">
            <div className="pm-week-sep">{group.label}</div>
            {group.dates.map((date) => {
              const day = seriesByDate.get(date);
              const lastPt = day?.points[day.points.length - 1] ?? null;
              const isFocus = date === focusDate;
              const pinIdx = pinnedDates.indexOf(date);
              const role = isFocus ? "focus" : pinIdx === 0 ? "pin-0" : pinIdx === 1 ? "pin-1" : "bg";
              const isFlow = day?.source === "flow";
              const isPending = isFlow && lastPt === null;
              const isLive = isFlow && lastPt !== null;
              const isTodayStore = !isFlow && date === todayStr;
              const volRatio = lastPt ? Math.max(8, Math.round((pointVolumeValue(lastPt, unit) / maxDayVol) * 100)) : 0;
              const weekday = formatKoreanWeekday(date);
              const dotRole = isPending ? "wait" : role;

              return (
                <div
                  key={date}
                  className="pm-date-row"
                  role="listitem"
                  data-date={date}
                  data-role={role}
                  data-pending={isPending}
                  data-spot={spotDate === date}
                  onPointerEnter={() => onSpotDate(date)}
                  onMouseEnter={() => onSpotDate(date)}
                >
                  <button
                    type="button"
                    className="pm-date-main"
                    data-testid={`premarket-day-chip-${date}`}
                    data-date={date}
                    data-role={role}
                    data-pending={isPending}
                    aria-pressed={isFocus || pinIdx >= 0}
                    onClick={() => onTogglePin(date)}
                  >
                    <span className="pm-day-dot" data-role={dotRole} aria-hidden="true" />
                    <span className="pm-date-label">
                      <span>{formatShortDate(date)}</span>
                      {isPending ? (
                        <span className="pm-row-tag" data-kind="wait">대기</span>
                      ) : isLive ? (
                        <span className="pm-row-tag" data-kind="live">실시간</span>
                      ) : isTodayStore ? (
                        <span className="pm-row-tag" data-kind="today">오늘</span>
                      ) : (
                        <span className="pm-date-dow">{weekday}</span>
                      )}
                    </span>
                    <span
                      className="pm-date-pct pm-val"
                      data-tone={isPending ? "accent" : valueTone(lastPt?.expectedReturnPct)}
                    >
                      {lastPt ? formatSignedPct(lastPt.expectedReturnPct, 1) : "—"}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="pm-date-star"
                    data-testid={`premarket-focus-btn-${date}`}
                    aria-label={`${formatShortDate(date)} 기준일 선택`}
                    aria-pressed={isFocus}
                    onClick={() => onSelectFocus(date)}
                  >
                    {isFocus ? "★" : "☆"}
                  </button>
                  {volRatio > 0 && (
                    <span
                      className="pm-vol-mini"
                      style={{ ["--vol-pct" as string]: `${volRatio}%` }}
                      aria-hidden="true"
                    />
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>
      <div className="pm-side-foot">호버 스포트라이트 · 클릭 핀(2) · ★ 기준</div>
    </aside>
  );
}
