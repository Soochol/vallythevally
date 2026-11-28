import { useEffect, useMemo, useRef, useState } from "react";
import { Popover } from "../overlay/Popover";

interface Props {
  readonly days: readonly string[];
  readonly archiveDays?: ReadonlySet<string>;
  readonly activeDate: string | null;
  readonly onSelect: (day: string) => void;
}

const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"] as const;

function parseYmd(ymd: string): { year: number; month: number; day: number } | null {
  if (!/^\d{8}$/.test(ymd)) return null;
  const year = Number(ymd.slice(0, 4));
  const month = Number(ymd.slice(4, 6));
  const day = Number(ymd.slice(6, 8));
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { year, month, day };
}

function toYmd(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, "0")}${String(month).padStart(2, "0")}${String(day).padStart(2, "0")}`;
}

function formatDateTrigger(ymd: string): string {
  const parsed = parseYmd(ymd);
  if (!parsed) return ymd;
  const weekday = WEEKDAYS[new Date(parsed.year, parsed.month - 1, parsed.day).getDay()] ?? "";
  return `${parsed.year}-${String(parsed.month).padStart(2, "0")}-${String(parsed.day).padStart(2, "0")} (${weekday})`;
}

export function ReplayDatePicker({ days, archiveDays, activeDate, onSelect }: Props) {
  const sortedDays = useMemo(() => [...days].sort(), [days]);
  const daySet = useMemo(() => new Set(sortedDays), [sortedDays]);
  const currentIdx = activeDate !== null ? sortedDays.indexOf(activeDate) : -1;
  const prevDay = currentIdx > 0 ? sortedDays[currentIdx - 1]! : null;
  const nextDay = currentIdx >= 0 && currentIdx < sortedDays.length - 1 ? sortedDays[currentIdx + 1]! : null;

  const yearMonthCounts = useMemo(() => {
    const byYear = new Map<number, Map<number, number>>();
    for (const ymd of sortedDays) {
      const parsed = parseYmd(ymd);
      if (!parsed) continue;
      let months = byYear.get(parsed.year);
      if (!months) {
        months = new Map<number, number>();
        byYear.set(parsed.year, months);
      }
      months.set(parsed.month, (months.get(parsed.month) ?? 0) + 1);
    }
    return byYear;
  }, [sortedDays]);

  const hasArchive = useMemo(() => {
    if (!archiveDays || archiveDays.size === 0) return false;
    return sortedDays.some((day) => archiveDays.has(day));
  }, [sortedDays, archiveDays]);

  const [open, setOpen] = useState(false);
  const [viewMonth, setViewMonth] = useState<{ year: number; month: number }>(() => {
    const parsed = activeDate ? parseYmd(activeDate) : null;
    if (parsed) return { year: parsed.year, month: parsed.month };
    const now = new Date();
    return { year: now.getFullYear(), month: now.getMonth() + 1 };
  });

  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!activeDate) return;
    const parsed = parseYmd(activeDate);
    if (parsed) setViewMonth({ year: parsed.year, month: parsed.month });
  }, [activeDate]);

  if (sortedDays.length === 0 || activeDate === null) return null;

  const firstWeekday = new Date(viewMonth.year, viewMonth.month - 1, 1).getDay();
  const daysInMonth = new Date(viewMonth.year, viewMonth.month, 0).getDate();
  const activeIsArchive = archiveDays?.has(activeDate) ?? false;

  const availableYears = Array.from(new Set([...yearMonthCounts.keys(), viewMonth.year])).sort((a, b) => a - b);
  const currentYearMonths = yearMonthCounts.get(viewMonth.year);

  const shiftMonth = (delta: number) => {
    setViewMonth((prev) => {
      const next = new Date(prev.year, prev.month - 1 + delta, 1);
      return { year: next.getFullYear(), month: next.getMonth() + 1 };
    });
  };

  const selectYear = (nextYear: number) => {
    const months = yearMonthCounts.get(nextYear);
    if (months && months.size > 0) {
      if (months.has(viewMonth.month)) {
        setViewMonth({ year: nextYear, month: viewMonth.month });
        return;
      }
      const sortedMonths = [...months.keys()].sort((a, b) => a - b);
      setViewMonth({ year: nextYear, month: sortedMonths[sortedMonths.length - 1]! });
      return;
    }
    setViewMonth({ year: nextYear, month: viewMonth.month });
  };

  return (
    <div className="rp-cal-control" data-testid="replay-date-picker">
      <button
        type="button"
        className="rp-cal-nav"
        data-testid="replay-date-prev"
        aria-label="이전 거래일"
        title="이전 거래일"
        disabled={prevDay === null}
        onClick={() => {
          if (prevDay) onSelect(prevDay);
        }}
      >
        ←
      </button>

      <button
        ref={triggerRef}
        type="button"
        className="rp-cal-trigger rp-mono"
        data-testid="replay-date-trigger"
        data-source={activeIsArchive ? "archive" : "native"}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((prev) => !prev)}
      >
        <span className="rp-cal-dot" data-source={activeIsArchive ? "archive" : "native"} aria-hidden="true" />
        <span>{formatDateTrigger(activeDate)}</span>
        <span className="rp-muted" aria-hidden="true">▾</span>
      </button>

      <button
        type="button"
        className="rp-cal-nav"
        data-testid="replay-date-next"
        aria-label="다음 거래일"
        title="다음 거래일"
        disabled={nextDay === null}
        onClick={() => {
          if (nextDay) onSelect(nextDay);
        }}
      >
        →
      </button>

      {open && (
        <Popover
          anchor={triggerRef}
          solid
          placement="bottom"
          role="dialog"
          aria-label="관측일 달력"
          data-testid="replay-date-popover"
          className="rp-cal-popover"
          onClose={() => setOpen(false)}
        >
          <div className="rp-cal-pop-head">
            <button type="button" className="rp-cal-nav" aria-label="이전 달" onClick={() => shiftMonth(-1)}>
              ‹
            </button>
            <div className="rp-cal-ym-group rp-mono">
              <select
                className="rp-cal-select"
                aria-label="연도 선택"
                data-testid="replay-date-year"
                value={viewMonth.year}
                onChange={(e) => selectYear(Number(e.target.value))}
              >
                {availableYears.map((year) => (
                  <option key={year} value={year}>{`${year}년`}</option>
                ))}
              </select>
              <select
                className="rp-cal-select"
                aria-label="월 선택"
                data-testid="replay-date-month"
                value={viewMonth.month}
                onChange={(e) => setViewMonth((prev) => ({ ...prev, month: Number(e.target.value) }))}
              >
                {Array.from({ length: 12 }, (_, idx) => {
                  const month = idx + 1;
                  const count = currentYearMonths?.get(month) ?? 0;
                  return (
                    <option key={month} value={month} disabled={count === 0 && month !== viewMonth.month}>
                      {count > 0 ? `${month}월 (${count})` : `${month}월`}
                    </option>
                  );
                })}
              </select>
            </div>
            <button type="button" className="rp-cal-nav" aria-label="다음 달" onClick={() => shiftMonth(1)}>
              ›
            </button>
          </div>

          <div className="rp-cal-weekdays">
            {WEEKDAYS.map((wd) => (
              <span key={wd}>{wd}</span>
            ))}
          </div>

          <div className="rp-cal-days rp-mono">
            {Array.from({ length: firstWeekday }, (_, i) => (
              <span key={`empty-${i}`} className="rp-cal-empty" />
            ))}
            {Array.from({ length: daysInMonth }, (_, i) => {
              const dayNum = i + 1;
              const ymd = toYmd(viewMonth.year, viewMonth.month, dayNum);
              const available = daySet.has(ymd);
              const isArchiveDay = available && (archiveDays?.has(ymd) ?? false);
              const selected = ymd === activeDate;
              return (
                <button
                  key={ymd}
                  type="button"
                  className="rp-cal-day"
                  data-date={ymd}
                  data-available={available ? "true" : "false"}
                  data-source={available ? (isArchiveDay ? "archive" : "native") : undefined}
                  aria-pressed={selected}
                  disabled={!available}
                  onClick={() => {
                    onSelect(ymd);
                    setOpen(false);
                  }}
                >
                  <span>{dayNum}</span>
                </button>
              );
            })}
          </div>

          <div className="rp-cal-pop-foot">
            <span className="rp-cal-legends">
              <span className="rp-cal-legend">
                <span className="rp-cal-dot" data-source="native" aria-hidden="true" />
                {hasArchive ? "통합" : "수집 데이터 있음"}
              </span>
              {hasArchive && (
                <span className="rp-cal-legend">
                  <span className="rp-cal-dot" data-source="archive" aria-hidden="true" />
                  KRX 아카이브
                </span>
              )}
            </span>
            <span className="rp-mono">{`${sortedDays.length}일 수집`}</span>
          </div>
        </Popover>
      )}
    </div>
  );
}
