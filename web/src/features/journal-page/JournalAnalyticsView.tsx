import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { ownsChartKeyboard } from "../overlay/topLayer";
import { Segmented } from "../ui/Segmented";
import { Switch } from "../ui/Switch";
import {
  activeFilterTokens,
  buildCalendarWeeks,
  buildTableGroups,
  clamp,
  DOW_KO,
  dayOfWeek,
  formatCompactWon,
  formatMinutes,
  formatPct,
  formatPeriodLabel,
  formatUtcMsToDay,
  formatWon,
  isPeriodAtToday,
  MINUS,
  pad2,
  parseDayUtcMs,
  toneClass,
  tradePnl,
} from "./journalEngine";
import { useJournalStore } from "./journalStore";
import type { JournalSummary, JournalTrade } from "./journalTypes";

interface Props {
  readonly allTrades: readonly JournalTrade[];
  readonly filteredAllTrades: readonly JournalTrade[];
  readonly periodTrades: readonly JournalTrade[];
  readonly filteredTrades: readonly JournalTrade[];
  readonly summary: JournalSummary;
  readonly range: readonly [string, string];
  readonly today: string;
  readonly isSyncingHistory: boolean;
  readonly pendingDays: number;
  readonly historyError: string | null;
  readonly onRetryHistory: () => void;
}

interface FlowHover {
  readonly x: number;
  readonly title: string;
  readonly rows: readonly { readonly label: string; readonly value: string; readonly tone?: "up" | "dn" | "" }[];
  readonly targetDay: string | null;
  readonly targetTradeId: string | null;
}

export function JournalAnalyticsView({
  allTrades,
  filteredAllTrades,
  periodTrades,
  filteredTrades,
  summary,
  range,
  today,
  isSyncingHistory,
  pendingDays,
  historyError,
  onRetryHistory,
}: Props) {
  const navigate = useNavigate();
  const tlRef = useRef<HTMLDivElement | null>(null);
  const [tlSize, setTlSize] = useState<{ w: number; h: number }>({ w: 860, h: 468 });
  const [flowHover, setFlowHover] = useState<FlowHover | null>(null);

  const period = useJournalStore((s) => s.period);
  const afterCost = useJournalStore((s) => s.afterCost);
  const filters = useJournalStore((s) => s.filters);
  const view = useJournalStore((s) => s.view);
  const grain = useJournalStore((s) => s.grain);
  const demoMode = useJournalStore((s) => s.demoMode);

  const setPeriodType = useJournalStore((s) => s.setPeriodType);
  const setPeriod = useJournalStore((s) => s.setPeriod);
  const stepPeriod = useJournalStore((s) => s.stepPeriod);
  const jumpToday = useJournalStore((s) => s.jumpToday);
  const toggleAfterCost = useJournalStore((s) => s.toggleAfterCost);
  const setFilter = useJournalStore((s) => s.setFilter);
  const clearFilter = useJournalStore((s) => s.clearFilter);
  const setView = useJournalStore((s) => s.setView);
  const setGrain = useJournalStore((s) => s.setGrain);
  const selectTrade = useJournalStore((s) => s.selectTrade);
  const setDemoMode = useJournalStore((s) => s.setDemoMode);

  useEffect(() => {
    const el = tlRef.current;
    if (el === null) return;
    const sync = () => {
      if (el.clientWidth > 0 && el.clientHeight > 0) {
        setTlSize({ w: el.clientWidth, h: el.clientHeight });
      }
    };
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    return () => ro.disconnect();
  }, [view]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing || ownsChartKeyboard(e)) return;
      const target = e.target;
      if (target instanceof Element && target.matches("textarea, input, select")) return;
      if (e.key === "Escape") clearFilter("*");
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [clearFilter]);

  const symbolNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const t of allTrades) map.set(t.code, t.name);
    return map;
  }, [allTrades]);

  const tokens = useMemo(() => activeFilterTokens(filters, symbolNames), [filters, symbolNames]);
  const isAtToday = isPeriodAtToday(period, range, today);

  const tradingDaysInRange = useMemo(() => {
    const out: string[] = [];
    const startMs = parseDayUtcMs(range[0]);
    const endMs = parseDayUtcMs(range[1]);
    for (let ms = startMs; ms <= endMs; ms += 864e5) {
      const dow = new Date(ms).getUTCDay();
      if (dow >= 1 && dow <= 5) out.push(formatUtcMsToDay(ms));
    }
    if (out.length === 0) out.push(range[0]);
    return out;
  }, [range]);

  const flowModel = useMemo(() => {
    const W = Math.max(280, tlSize.w);
    const H = Math.max(240, tlSize.h);
    const single = range[0] === range[1];
    const dayIndex = new Map(tradingDaysInRange.map((d, i) => [d, i]));
    const top = 18;
    const axis = 22;
    const gap = 18;
    const barsH = Math.round((H - axis) * 0.28);
    const lineH = Math.max(40, H - axis - barsH - gap - top);
    const n = single ? 540 : tradingDaysInRange.length;
    const sw = W / Math.max(1, n);

    const xOfTrade = (t: JournalTrade) => {
      if (single) return clamp(t.exitMin - 480 + 0.5, 0, 540) * sw;
      const idx = dayIndex.get(t.exitDay) ?? 0;
      return (idx + clamp(t.exitMin - 480 + 0.5, 0, 540) / 540) * sw;
    };

    let cum = 0;
    let cmin = 0;
    let cmax = 0;
    const pts: { x: number; cum: number; trade: JournalTrade }[] = [];
    const sums = new Map<string, number>();
    const cnt = new Map<string, number>();
    const cumEnd = new Map<string, number>();

    for (const t of filteredTrades) {
      const p = tradePnl(t, afterCost);
      cum += p;
      pts.push({ x: xOfTrade(t), cum, trade: t });
      if (cum < cmin) cmin = cum;
      if (cum > cmax) cmax = cum;
      sums.set(t.exitDay, (sums.get(t.exitDay) ?? 0) + p);
      cnt.set(t.exitDay, (cnt.get(t.exitDay) ?? 0) + 1);
      cumEnd.set(t.exitDay, cum);
    }

    const cr = cmax - cmin || 1;
    const cy = (v: number) => top + ((cmax - v) / cr) * lineH;
    const y0 = cy(0);

    let dLine = `M0 ${y0.toFixed(1)}`;
    for (const p of pts) dLine += `H${p.x.toFixed(1)}V${cy(p.cum).toFixed(1)}`;
    dLine += `H${W}`;
    const dArea = `${dLine}V${y0.toFixed(1)}H0Z`;

    const bars = single
      ? pts.map((p) => ({ x: p.x, v: tradePnl(p.trade, afterCost) }))
      : [...sums.entries()].map(([day, v]) => ({ x: ((dayIndex.get(day) ?? 0) + 0.5) * sw, v }));

    const bp = Math.max(0, ...bars.map((b) => b.v));
    const bn = Math.max(0, ...bars.map((b) => -b.v));
    const bs = barsH / (bp + bn || 1);
    const by0 = top + lineH + gap + bp * bs;
    const bw = single ? 6 : Math.max(2, Math.min(16, sw * 0.6));

    const labels: { x: number; text: string }[] = [];
    if (single) {
      for (let h = 8; h <= 17; h += 1) labels.push({ x: (h * 60 - 480) * sw, text: `${h}시` });
    } else if (tradingDaysInRange.length <= 6) {
      for (let i = 0; i < tradingDaysInRange.length; i += 1) {
        const d = tradingDaysInRange[i]!;
        const dd = Number(d.slice(8, 10));
        labels.push({ x: (i + 0.5) * sw, text: `${dd}일 ${DOW_KO[dayOfWeek(d)]}` });
      }
    } else if (tradingDaysInRange.length <= 32) {
      for (let i = 0; i < tradingDaysInRange.length; i += 1) {
        const d = tradingDaysInRange[i]!;
        if (i === 0 || dayOfWeek(d) === 1) {
          labels.push({ x: i * sw, text: `${Number(d.slice(5, 7))}.${Number(d.slice(8, 10))}` });
        }
      }
    } else {
      for (let i = 0; i < tradingDaysInRange.length; i += 1) {
        const d = tradingDaysInRange[i]!;
        const prev = i > 0 ? tradingDaysInRange[i - 1]! : "";
        if (i === 0 || d.slice(0, 7) !== prev.slice(0, 7)) {
          const m = Number(d.slice(5, 7));
          labels.push({ x: i * sw, text: m === 1 || i === 0 ? `${d.slice(0, 4)}.${m}` : `${m}월` });
        }
      }
    }

    const filteredLabels = labels.filter((l, i) => i === 0 || l.x - labels[i - 1]!.x > 46);
    const endCum = pts.length > 0 ? pts[pts.length - 1]!.cum : 0;

    return {
      W,
      H,
      top,
      axis,
      gap,
      lineH,
      single,
      sw,
      n,
      pts,
      sums,
      cnt,
      cumEnd,
      dLine,
      dArea,
      y0,
      bars,
      bs,
      by0,
      bw,
      labels: filteredLabels,
      endY: cy(endCum),
      areaColor: cum > 0 ? "var(--up)" : cum < 0 ? "var(--down)" : "var(--text-3)",
    };
  }, [filteredTrades, tradingDaysInRange, range, afterCost, tlSize]);

  const calendarMonth = useMemo(
    () => buildCalendarWeeks(period.anchor, range, filteredAllTrades, afterCost),
    [period.anchor, range, filteredAllTrades, afterCost],
  );

  const yearMonths = useMemo(() => {
    if (period.type !== "year" && period.type !== "all") return [];
    const map = new Map<string, { ym: string; firstDay: string; pnl: number; count: number }>();
    const startYear = Number(range[0].slice(0, 4));
    const startMonth = Number(range[0].slice(5, 7));
    const endYear = Number(range[1].slice(0, 4));
    const endMonth = Number(range[1].slice(5, 7));
    let y = startYear;
    let m = startMonth;
    while (y < endYear || (y === endYear && m <= endMonth)) {
      const ym = `${y}-${pad2(m)}`;
      map.set(ym, { ym, firstDay: `${ym}-15`, pnl: 0, count: 0 });
      m += 1;
      if (m > 12) {
        m = 1;
        y += 1;
      }
    }
    for (const t of filteredTrades) {
      const ym = t.exitDay.slice(0, 7);
      const entry = map.get(ym);
      if (entry !== undefined) {
        entry.pnl += tradePnl(t, afterCost);
        entry.count += 1;
      }
    }
    return [...map.values()];
  }, [period.type, range, filteredTrades, afterCost]);

  const tableRows = useMemo(() => buildTableGroups(filteredTrades, grain, afterCost), [filteredTrades, grain, afterCost]);

  const jumpToDay = (day: string) => {
    setPeriod({ type: "day", anchor: day });
    void navigate("/journal");
  };

  const jumpToMonth = (firstDay: string) => {
    setPeriod({ type: "month", anchor: firstDay });
    void navigate("/journal");
  };

  const jumpToTableRow = (rowKey: string, anchorDay: string) => {
    if (grain === "sym") {
      setFilter("sym", rowKey);
    } else {
      setPeriod({ type: grain, anchor: anchorDay });
    }
    void navigate("/journal");
  };

  const netTone = toneClass(summary.net);
  const retTone = toneClass(summary.retPct);

  const tlMetaText =
    view === "flow"
      ? summary.mdd < 0
        ? `최대 낙폭 ${formatCompactWon(summary.mdd)}`
        : ""
      : view === "cal"
        ? period.type === "year" || period.type === "all"
          ? `${yearMonths.filter((m) => m.count > 0 && m.pnl > 0).length}승월 · ${yearMonths.filter((m) => m.count > 0 && m.pnl < 0).length}패월`
          : `${calendarMonth.year}년 ${calendarMonth.month}월 · ${calendarMonth.winDays}승일 · ${calendarMonth.lossDays}패일`
        : `${tableRows.length}개 항목`;

  return (
    <div className="jrn-shell" data-testid="journal-analytics-view">
      <header className="jrn-top">
        <div className="jrn-top-inner">
          <button
            type="button"
            className="jrn-route-btn"
            data-testid="journal-back-btn"
            onClick={() => void navigate("/journal")}
          >
            ← 매매복기
          </button>
          <span className="jrn-vsep" />
          <Segmented
            label="기간 단위"
            mode="pressed"
            size="sm"
            value={period.type}
            options={[
              { value: "day", label: "일" },
              { value: "week", label: "주" },
              { value: "month", label: "월" },
              { value: "year", label: "년" },
              { value: "all", label: "전체" },
            ]}
            onChange={(p) => setPeriodType(p)}
          />
          <div className="jrn-step">
            <button
              type="button"
              className="jrn-icon-btn"
              aria-label="이전 기간"
              disabled={period.type === "all"}
              onClick={() => stepPeriod(-1, today)}
            >
              ‹
            </button>
            <span className="jrn-step-label" data-testid="analytics-period-label">
              {formatPeriodLabel(period, range)}
            </span>
            <button
              type="button"
              className="jrn-icon-btn"
              aria-label="다음 기간"
              disabled={period.type === "all" || isAtToday}
              onClick={() => stepPeriod(1, today)}
            >
              ›
            </button>
            {!isAtToday && (
              <button type="button" className="jrn-txt-btn" onClick={() => jumpToday(today)}>
                오늘
              </button>
            )}
          </div>
          <div className="jrn-tokens" aria-label="적용된 조건">
            {tokens.map((tk) => (
              <button key={tk.key} type="button" className="jrn-tok" onClick={() => clearFilter(tk.key)}>
                <span>{tk.label}</span>
                <span aria-hidden="true">×</span>
              </button>
            ))}
            {tokens.length > 1 && (
              <button type="button" className="jrn-txt-btn" onClick={() => clearFilter("*")}>
                모두 지우기
              </button>
            )}
          </div>
          <span className="jrn-grow" />
          {isSyncingHistory && (
            <span className="jrn-mute jrn-fs-xs" data-testid="analytics-sync-status">
              {pendingDays > 0 ? `과거 체결 불러오는 중 (${pendingDays}일 남음)` : "체결 불러오는 중…"}
            </span>
          )}
          {historyError !== null && (
            <button type="button" className="jrn-txt-btn" data-testid="analytics-retry-history" onClick={onRetryHistory}>
              {`${historyError} · 다시 시도`}
            </button>
          )}
          {demoMode && (
            <button type="button" className="jrn-txt-btn" onClick={() => setDemoMode(false)}>
              예시 데이터 닫기
            </button>
          )}
          <Switch
            size="sm"
            checked={afterCost}
            testId="analytics-cost-switch"
            className="jrn-cost-switch"
            label={<span className="text-s text-text-2">{afterCost ? "세후" : "세전"}</span>}
            onChange={toggleAfterCost}
          />
          <button
            type="button"
            className="jrn-route-btn jrn-route-primary"
            onClick={() => void navigate("/journal")}
          >
            {tokens.length > 0 ? `조건 거래 ${summary.count}건 복기 ↗` : "매매복기에서 보기 ↗"}
          </button>
        </div>
      </header>

      <div className="jrn-an-page">
        <section className="jrn-an-hero" aria-label="실현손익 결산">
          <div>
            <div className="jrn-h-kicker">
              <span>{`${formatPeriodLabel(period, range)} 실현손익`}</span>
              <span className="jrn-mute">· FIFO</span>
            </div>
            <div className="jrn-h-scope">
              {summary.count !== periodTrades.length ? `조건 적용 ${summary.count}건 · 기간 전체 ${periodTrades.length}건` : ""}
            </div>
            <div className="jrn-h-net-row">
              <div className="jrn-h-net" data-testid="analytics-net-pnl">
                <span className={netTone ? `jrn-${netTone}` : ""}>{formatWon(summary.net)}</span>
                <small>원</small>
              </div>
              <div className={`jrn-h-ret${retTone ? ` jrn-${retTone}` : ""}`}>{formatPct(summary.retPct)}</div>
            </div>

            <dl className="jrn-h-stats">
              <div className="jrn-h-stat">
                <dt>거래</dt>
                <dd>{`${summary.count}건`}</dd>
                <small>{`당일 ${summary.count - summary.swingCount} · 스윙 ${summary.swingCount}`}</small>
              </div>
              <div className="jrn-h-stat">
                <dt>수익 · 손실</dt>
                <dd>{`${summary.wins}승 ${summary.losses}패`}</dd>
                <small>{`승률 ${summary.count > 0 ? `${summary.winRate.toFixed(1)}%` : "—"}`}</small>
              </div>
              <div className="jrn-h-stat">
                <dt>평균 손익</dt>
                <dd>
                  <span className="jrn-up">{summary.wins > 0 ? formatCompactWon(summary.avgWin) : "—"}</span>
                  {" / "}
                  <span className="jrn-dn">{summary.losses > 0 ? formatCompactWon(summary.avgLoss) : "—"}</span>
                </dd>
                <small>{`손익비 ${summary.count > 0 ? summary.rr.toFixed(2) : "—"}`}</small>
              </div>
            </dl>

            <div className="jrn-ledger">
              <div className="jrn-ledger-row">
                <span>총 매도</span>
                <b>{`${formatWon(summary.sellAmt, false)}원`}</b>
              </div>
              <div className="jrn-ledger-row">
                <span>총 매입</span>
                <b>{`${MINUS}${formatWon(summary.buyAmt, false)}원`}</b>
              </div>
              <div className="jrn-ledger-row">
                <Switch
                  size="sm"
                  checked={afterCost}
                  label={<span className="text-s text-text-2">수수료·세금 반영</span>}
                  onChange={toggleAfterCost}
                />
                <b className={afterCost ? undefined : "jrn-mute line-through"}>{`${MINUS}${formatWon(summary.cost, false)}원`}</b>
              </div>
              <div className="jrn-ledger-row jrn-ledger-total">
                <span>{afterCost ? "순 실현손익 (세후)" : "실현손익 (세전)"}</span>
                <b className={netTone ? `jrn-${netTone}` : ""}>{`${formatWon(summary.net)}원`}</b>
              </div>
            </div>
          </div>

          <div className="jrn-tl-col">
            <div className="jrn-tl-head">
              <Segmented
                label="기간별 보기"
                mode="pressed"
                size="sm"
                value={view}
                options={[
                  { value: "flow", label: "흐름" },
                  { value: "cal", label: "달력" },
                  { value: "table", label: "표" },
                ]}
                onChange={setView}
              />
              <div className="jrn-tl-right">
                <span>{tlMetaText}</span>
                {view === "table" && (
                  <Segmented
                    label="표 묶음 단위"
                    mode="pressed"
                    size="sm"
                    value={grain}
                    options={[
                      { value: "day", label: "일별" },
                      { value: "month", label: "월별" },
                      { value: "year", label: "연별" },
                      { value: "sym", label: "종목별" },
                    ]}
                    onChange={setGrain}
                  />
                )}
              </div>
            </div>

            <div ref={tlRef} className="jrn-tl-body" data-testid="analytics-explorer-body">
              {view === "flow" && (
                filteredTrades.length === 0 ? (
                  <div className="jrn-tl-empty">이 조건에 해당하는 청산 거래가 없습니다</div>
                ) : (
                  <div
                    className="jrn-flow-wrap"
                    onMouseMove={(e) => {
                      const rect = e.currentTarget.getBoundingClientRect();
                      const x = e.clientX - rect.left;
                      if (flowModel.single) {
                        let best = flowModel.pts[0]!;
                        for (const p of flowModel.pts) {
                          if (Math.abs(p.x - x) < Math.abs(best.x - x)) best = p;
                        }
                        const tp = tradePnl(best.trade, afterCost);
                        setFlowHover({
                          x: best.x,
                          title: best.trade.name,
                          rows: [
                            { label: "청산", value: formatMinutes(best.trade.exitMin) },
                            { label: "손익", value: `${formatWon(tp)}원`, tone: toneClass(tp) },
                            { label: "누적", value: `${formatWon(best.cum)}원` },
                          ],
                          targetDay: null,
                          targetTradeId: best.trade.id,
                        });
                      } else {
                        const idx = clamp(Math.floor(x / flowModel.sw), 0, tradingDaysInRange.length - 1);
                        const day = tradingDaysInRange[idx]!;
                        let ce = 0;
                        for (let i = idx; i >= 0; i -= 1) {
                          const d = tradingDaysInRange[i]!;
                          if (flowModel.cumEnd.has(d)) {
                            ce = flowModel.cumEnd.get(d)!;
                            break;
                          }
                        }
                        const v = flowModel.sums.get(day) ?? 0;
                        const [, m, dd] = day.split("-").map(Number);
                        setFlowHover({
                          x: (idx + 0.5) * flowModel.sw,
                          title: `${m}월 ${dd}일 ${DOW_KO[dayOfWeek(day)]}`,
                          rows: [
                            { label: "당일", value: `${formatWon(v)}원`, tone: toneClass(v) },
                            { label: "누적", value: `${formatWon(ce)}원` },
                            { label: "거래", value: `${flowModel.cnt.get(day) ?? 0}건` },
                          ],
                          targetDay: day,
                          targetTradeId: null,
                        });
                      }
                    }}
                    onMouseLeave={() => setFlowHover(null)}
                    onClick={() => {
                      if (flowHover === null) return;
                      if (flowHover.targetTradeId !== null) {
                        selectTrade(flowHover.targetTradeId);
                        void navigate("/journal");
                      } else if (flowHover.targetDay !== null) {
                        jumpToDay(flowHover.targetDay);
                      }
                    }}
                  >
                    <svg width={flowModel.W} height={flowModel.H} role="img" aria-label="누적 실현손익 흐름">
                      <defs>
                        <linearGradient id="jrnFlowGrad" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor={flowModel.areaColor} stopOpacity="0.16" />
                          <stop offset="100%" stopColor={flowModel.areaColor} stopOpacity="0" />
                        </linearGradient>
                      </defs>
                      <text x="0" y="10">누적</text>
                      <text x="0" y={flowModel.top + flowModel.lineH + flowModel.gap - 4}>
                        {flowModel.single ? "거래별 (클릭 시 차트 복기)" : "일별 (클릭 시 해당 날 복기로 이동)"}
                      </text>
                      <line className="jrn-z-dash" x1="0" x2={flowModel.W} y1={flowModel.y0} y2={flowModel.y0} />
                      <line className="jrn-z-line" x1="0" x2={flowModel.W} y1={flowModel.by0} y2={flowModel.by0} />
                      <path d={flowModel.dArea} fill="url(#jrnFlowGrad)" />
                      {flowModel.bars.map((b, i) => {
                        const bh = Math.max(2, Math.abs(b.v) * flowModel.bs);
                        return (
                          <rect
                            key={i}
                            className={b.v > 0 ? "jrn-f-up" : b.v < 0 ? "jrn-f-dn" : "jrn-f-flat"}
                            x={b.x - flowModel.bw / 2}
                            y={b.v >= 0 ? flowModel.by0 - bh : flowModel.by0}
                            width={flowModel.bw}
                            height={bh}
                            rx="1.5"
                            opacity="0.88"
                          />
                        );
                      })}
                      <path className="jrn-cum-path" d={flowModel.dLine} />
                      <circle className="jrn-f-ink" cx={flowModel.W} cy={flowModel.endY} r="3.2" />
                      {flowHover !== null && (
                        <line
                          className="jrn-guide"
                          x1={flowHover.x}
                          x2={flowHover.x}
                          y1={flowModel.top}
                          y2={flowModel.H - flowModel.axis}
                        />
                      )}
                      {flowModel.labels.map((l, i) => (
                        <text key={i} x={clamp(l.x, 12, flowModel.W - 24)} y={flowModel.H - 5}>
                          {l.text}
                        </text>
                      ))}
                    </svg>
                    {flowHover !== null && (
                      <div
                        className="jrn-tip"
                        style={{ left: `${clamp(flowHover.x + 14, 0, Math.max(0, flowModel.W - 180))}px` }}
                      >
                        <b>{flowHover.title}</b>
                        {flowHover.rows.map((r) => (
                          <div key={r.label}>
                            <span>{r.label}</span>
                            <span className={r.tone ? `jrn-${r.tone}` : ""}>{r.value}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )
              )}

              {view === "cal" && (
                period.type === "year" || period.type === "all" ? (
                  <div className="jrn-cal jrn-cal-m">
                    <div className="jrn-cal-grid jrn-cal-months">
                      {yearMonths.map((mo) => {
                        const maxM = Math.max(1, ...yearMonths.map((x) => Math.abs(x.pnl)));
                        const mTone = toneClass(mo.pnl);
                        const [, mStr] = mo.ym.split("-");
                        const mNum = Number(mStr);
                        return (
                          <button
                            key={mo.ym}
                            type="button"
                            className={`jrn-cal-c${mo.count > 0 ? (mo.pnl > 0 ? " jrn-cal-up" : mo.pnl < 0 ? " jrn-cal-dn" : "") : ""}`}
                            onClick={() => jumpToMonth(mo.firstDay)}
                          >
                            <div className="jrn-cal-top">
                              <b>{period.type === "all" || mNum === 1 ? mo.ym.replace("-", ".") : `${mNum}월`}</b>
                              <span>{mo.count > 0 ? `${mo.count}건` : ""}</span>
                            </div>
                            <div className={`jrn-cal-val${mTone ? ` jrn-${mTone}` : ""}`}>
                              {mo.count > 0 ? formatCompactWon(mo.pnl) : "—"}
                            </div>
                            {mo.count > 0 && (
                              <i
                                className={`jrn-cal-bar${mTone ? ` jrn-${mTone}` : ""}`}
                                style={{ width: `${Math.max(12, (Math.abs(mo.pnl) / maxM) * 100).toFixed(1)}%` }}
                              />
                            )}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ) : (
                  <div className="jrn-cal jrn-cal-daily">
                    <div className="jrn-cal-dow">
                      {["월", "화", "수", "목", "금", "주간"].map((d) => (
                        <span key={d}>{d}</span>
                      ))}
                    </div>
                    <div
                      className="jrn-cal-grid jrn-cal-has-wk"
                      style={{ gridTemplateRows: `repeat(${Math.max(1, calendarMonth.weeks.length)}, minmax(0, 1fr))` }}
                    >
                      {calendarMonth.weeks.map((wk, wi) => {
                        const wkTone = toneClass(wk.weekPnl);
                        return (
                          <div key={wi} className="jrn-cal-week-row">
                            {wk.cells.map((c, ci) => {
                              if (c === null) return <span key={ci} className="jrn-cal-c jrn-cal-empty" />;
                              const cTone = toneClass(c.pnl);
                              return (
                                <button
                                  key={c.day}
                                  type="button"
                                  data-testid={`analytics-cal-day-${c.day}`}
                                  className={`jrn-cal-c${c.inRange ? "" : " jrn-cal-out"}${c.count > 0 ? (c.pnl > 0 ? " jrn-cal-up" : c.pnl < 0 ? " jrn-cal-dn" : "") : ""}`}
                                  aria-pressed={period.type === "day" && range[0] === c.day}
                                  onClick={() => jumpToDay(c.day)}
                                >
                                  <div className="jrn-cal-top">
                                    <b>{c.dayNum}</b>
                                    <span>{c.count > 0 ? `${c.count}건` : ""}</span>
                                  </div>
                                  <div className={`jrn-cal-val${cTone ? ` jrn-${cTone}` : ""}`}>
                                    {c.count > 0 ? formatCompactWon(c.pnl) : ""}
                                  </div>
                                  {c.count > 0 && (
                                    <i
                                      className={`jrn-cal-bar${cTone ? ` jrn-${cTone}` : ""}`}
                                      style={{ width: `${Math.max(14, (Math.abs(c.pnl) / calendarMonth.maxAbs) * 100).toFixed(1)}%` }}
                                    />
                                  )}
                                </button>
                              );
                            })}
                            <div className="jrn-cal-c jrn-cal-wk">
                              <div className="jrn-cal-top">
                                <span>{wk.weekCount > 0 ? `${wk.weekCount}건` : ""}</span>
                              </div>
                              <div className={`jrn-cal-val${wk.weekCount > 0 && wkTone ? ` jrn-${wkTone}` : " jrn-mute"}`}>
                                {wk.weekCount > 0 ? formatCompactWon(wk.weekPnl) : "—"}
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )
              )}

              {view === "table" && (
                tableRows.length === 0 ? (
                  <div className="jrn-tl-empty">이 조건에 해당하는 청산 거래가 없습니다</div>
                ) : (
                  <div className="jrn-tbl">
                    <table>
                      <thead>
                        <tr>
                          <th>{grain === "sym" ? "종목" : "기간"}</th>
                          <th>거래</th>
                          <th>승률</th>
                          <th>매입</th>
                          <th>매도</th>
                          <th>수수료·세금</th>
                          <th>순손익</th>
                          <th>수익률</th>
                          <th />
                        </tr>
                      </thead>
                      <tbody>
                        {tableRows.map((row) => {
                          const pTone = toneClass(row.summary.net);
                          const rTone = toneClass(row.summary.retPct);
                          return (
                            <tr
                              key={row.key}
                              tabIndex={0}
                              data-testid={`analytics-table-row-${row.key}`}
                              onClick={() => jumpToTableRow(row.key, row.anchorDay)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") jumpToTableRow(row.key, row.anchorDay);
                              }}
                            >
                              <td>{row.label}</td>
                              <td>{`${row.summary.count}건`}</td>
                              <td className="jrn-sub">{row.summary.count > 0 ? `${row.summary.winRate.toFixed(0)}%` : "—"}</td>
                              <td className="jrn-sub">{formatWon(row.summary.buyAmt, false)}</td>
                              <td className="jrn-sub">{formatWon(row.summary.sellAmt, false)}</td>
                              <td className="jrn-sub">{afterCost ? formatWon(row.summary.cost, false) : "제외"}</td>
                              <td className={pTone ? `jrn-${pTone}` : ""}><b>{formatWon(row.summary.net)}</b></td>
                              <td className={rTone ? `jrn-${rTone}` : ""}>{formatPct(row.summary.retPct)}</td>
                              <td>
                                <span className="jrn-row-jump">복기 ↗</span>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                      <tfoot>
                        <tr>
                          <td>합계</td>
                          <td>{`${summary.count}건`}</td>
                          <td className="jrn-sub">{summary.count > 0 ? `${summary.winRate.toFixed(0)}%` : "—"}</td>
                          <td className="jrn-sub">{formatWon(summary.buyAmt, false)}</td>
                          <td className="jrn-sub">{formatWon(summary.sellAmt, false)}</td>
                          <td className="jrn-sub">{afterCost ? formatWon(summary.cost, false) : "제외"}</td>
                          <td className={netTone ? `jrn-${netTone}` : ""}><b>{formatWon(summary.net)}</b></td>
                          <td className={retTone ? `jrn-${retTone}` : ""}>{formatPct(summary.retPct)}</td>
                          <td />
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                )
              )}
            </div>
            <div className="jrn-tl-hint">
              날짜 · 월 · 표의 행 또는 종목을 클릭하면 해당 기간/종목이 유지된 채 매매복기(/journal)로 바로 이동합니다
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
