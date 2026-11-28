import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { Select } from "../menu/Select";
import { ownsChartKeyboard } from "../overlay/topLayer";
import { JOURNAL_ANALYTICS_PATH } from "../page-rail/pages";
import { Segmented } from "../ui/Segmented";
import { JournalCandleChart } from "./JournalCandleChart";
import {
  activeFilterTokens,
  autoTfForTrades,
  buildDaySymbolGroups,
  clamp,
  DOW_KO,
  dayOfWeek,
  dayShortLabel,
  formatCompactWon,
  formatHoldDuration,
  formatMinutes,
  formatPct,
  formatPeriodLabel,
  formatWon,
  isPeriodAtToday,
  resolveNote,
  toneClass,
  tradePnl,
  tradeRetPct,
} from "./journalEngine";
import { useJournalStore } from "./journalStore";
import {
  DEFAULT_TAGS,
  JOURNAL_TFS,
  STYLE_SHORT,
  type JournalFill,
  type JournalSummary,
  type JournalSymbolGroup,
  type JournalTrade,
} from "./journalTypes";
import { JournalWhereSection } from "./JournalWhereSection";

interface Props {
  readonly allTrades: readonly JournalTrade[];
  readonly periodTrades: readonly JournalTrade[];
  readonly visibleList: readonly JournalTrade[];
  readonly summary: JournalSummary;
  readonly range: readonly [string, string];
  readonly today: string;
  readonly hasRealTrades: boolean;
  readonly isSyncingHistory: boolean;
  readonly pendingDays: number;
  readonly historyError: string | null;
  readonly onRetryHistory: () => void;
}

type ResolvedSelection =
  | { readonly kind: "group"; readonly group: JournalSymbolGroup }
  | { readonly kind: "trade"; readonly group: JournalSymbolGroup; readonly trade: JournalTrade };

export function JournalStudioView({
  allTrades,
  periodTrades,
  visibleList,
  summary,
  range,
  today,
  hasRealTrades,
  isSyncingHistory,
  pendingDays,
  historyError,
  onRetryHistory,
}: Props) {
  const navigate = useNavigate();
  const rootRef = useRef<HTMLDivElement | null>(null);

  const period = useJournalStore((s) => s.period);
  const afterCost = useJournalStore((s) => s.afterCost);
  const filters = useJournalStore((s) => s.filters);
  const sort = useJournalStore((s) => s.sort);
  const sortDir = useJournalStore((s) => s.sortDir);
  const quick = useJournalStore((s) => s.quick);
  const selection = useJournalStore((s) => s.selection);
  const tfOverride = useJournalStore((s) => s.tf);
  const demoMode = useJournalStore((s) => s.demoMode);
  const notes = useJournalStore((s) => s.notes);

  const setPeriodType = useJournalStore((s) => s.setPeriodType);
  const stepPeriod = useJournalStore((s) => s.stepPeriod);
  const jumpToday = useJournalStore((s) => s.jumpToday);
  const setFilter = useJournalStore((s) => s.setFilter);
  const clearFilter = useJournalStore((s) => s.clearFilter);
  const setSort = useJournalStore((s) => s.setSort);
  const setQuick = useJournalStore((s) => s.setQuick);
  const selectTrade = useJournalStore((s) => s.selectTrade);
  const selectGroup = useJournalStore((s) => s.selectGroup);
  const setTf = useJournalStore((s) => s.setTf);
  const setDemoMode = useJournalStore((s) => s.setDemoMode);
  const saveMemo = useJournalStore((s) => s.saveMemo);
  const toggleTradeTag = useJournalStore((s) => s.toggleTradeTag);

  const [highlightFill, setHighlightFill] = useState<JournalFill | null>(null);
  const [resetTick, setResetTick] = useState(0);
  const [savedFlash, setSavedFlash] = useState(false);

  const symbolNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const t of allTrades) map.set(t.code, t.name);
    return map;
  }, [allTrades]);

  const periodSymbols = useMemo(() => {
    const map = new Map<string, string>();
    for (const t of periodTrades) map.set(t.code, t.name);
    if (filters.sym !== null && !map.has(filters.sym)) {
      map.set(filters.sym, symbolNames.get(filters.sym) ?? filters.sym);
    }
    return [...map.entries()].sort((a, b) => a[1].localeCompare(b[1], "ko"));
  }, [periodTrades, filters.sym, symbolNames]);

  const groups = useMemo(
    () => buildDaySymbolGroups(visibleList, sort, sortDir, afterCost),
    [visibleList, sort, sortDir, afterCost],
  );

  const resolved = useMemo<ResolvedSelection | null>(() => {
    if (groups.length === 0) return null;
    if (selection?.kind === "trade") {
      for (const group of groups) {
        const trade = group.trades.find((t) => t.id === selection.id);
        if (trade !== undefined) return { kind: "trade", group, trade };
      }
    }
    if (selection?.kind === "group") {
      const group = groups.find((g) => g.key === selection.key);
      if (group !== undefined) {
        return group.trades.length > 1
          ? { kind: "group", group }
          : { kind: "trade", group, trade: group.trades[0]! };
      }
    }
    const first = groups[0]!;
    return first.trades.length > 1
      ? { kind: "group", group: first }
      : { kind: "trade", group: first, trade: first.trades[0]! };
  }, [groups, selection]);

  const activeGroup = resolved?.group ?? null;
  const selectedTrade = resolved?.kind === "trade" ? resolved.trade : null;
  const activeTrades = useMemo(
    () => (resolved === null ? [] : resolved.kind === "group" ? resolved.group.trades : [resolved.trade]),
    [resolved],
  );
  const activeTf = activeTrades.length > 0 ? tfOverride ?? autoTfForTrades(activeTrades) : "1";

  const glyphCap = useMemo(() => {
    if (visibleList.length === 0) return 5;
    const reaches = visibleList.map((t) => Math.max(t.mfe, -t.mae, Math.abs(t.exitRet))).sort((a, b) => a - b);
    return Math.max(1.2, reaches[Math.floor((reaches.length - 1) * 0.9)] ?? 5);
  }, [visibleList]);

  const showDayHeaders = sort === "time" && range[0] !== range[1];
  const daySums = useMemo(() => {
    const map = new Map<string, number>();
    if (!showDayHeaders) return map;
    for (const g of groups) map.set(g.day, (map.get(g.day) ?? 0) + g.net);
    return map;
  }, [groups, showDayHeaders]);

  const tokens = useMemo(() => activeFilterTokens(filters, symbolNames), [filters, symbolNames]);
  const extraTokens = useMemo(() => tokens.filter((t) => t.key !== "sym" && t.key !== "tag"), [tokens]);

  const selectionIdentity = resolved === null ? "" : resolved.kind === "group" ? `g:${resolved.group.key}` : `t:${resolved.trade.id}`;
  useEffect(() => {
    setHighlightFill(null);
  }, [selectionIdentity]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing || ownsChartKeyboard(e)) return;
      const target = e.target;
      const typing = target instanceof Element && target.matches("textarea, input, select");
      if (e.key === "Escape") {
        if (typing && target instanceof HTMLElement) target.blur();
        else clearFilter("*");
        return;
      }
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      if ((e.key === "ArrowDown" || e.key === "j" || e.key === "ArrowUp" || e.key === "k") && groups.length > 0) {
        e.preventDefault();
        const curIdx = groups.findIndex((g) => g.key === activeGroup?.key);
        const delta = e.key === "ArrowDown" || e.key === "j" ? 1 : -1;
        const nextIdx = clamp((curIdx < 0 ? 0 : curIdx) + delta, 0, groups.length - 1);
        const nextGroup = groups[nextIdx]!;
        if (nextGroup.trades.length > 1) selectGroup(nextGroup.key);
        else selectTrade(nextGroup.trades[0]!.id);
      } else if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && activeGroup !== null && activeGroup.trades.length > 1) {
        e.preventDefault();
        const curPos = resolved?.kind === "trade" ? activeGroup.trades.findIndex((t) => t.id === resolved.trade.id) + 1 : 0;
        const nextPos = clamp(curPos + (e.key === "ArrowRight" ? 1 : -1), 0, activeGroup.trades.length);
        if (nextPos === 0) selectGroup(activeGroup.key);
        else selectTrade(activeGroup.trades[nextPos - 1]!.id);
      } else if (e.key === "1" || e.key === "3" || e.key === "5" || e.key.toLowerCase() === "d") {
        setTf(e.key.toUpperCase() as "1" | "3" | "5" | "D");
      } else if (e.key === "0") {
        setResetTick((v) => v + 1);
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [groups, activeGroup, resolved, clearFilter, selectGroup, selectTrade, setTf]);

  const fillsOfActive = useMemo(() => {
    const out: { readonly fill: JournalFill; readonly seq: number; readonly multi: boolean; readonly rtIdx: number }[] = [];
    activeTrades.forEach((t, ti) => {
      t.buys.forEach((f, i) => out.push({ fill: f, seq: i + 1, multi: t.buys.length > 1, rtIdx: ti + 1 }));
      t.sells.forEach((f, i) => out.push({ fill: f, seq: i + 1, multi: t.sells.length > 1, rtIdx: ti + 1 }));
    });
    return out.sort(
      (a, b) =>
        a.fill.day.localeCompare(b.fill.day) ||
        a.fill.minutes - b.fill.minutes ||
        a.fill.orderNo.localeCompare(b.fill.orderNo, undefined, { numeric: true }),
    );
  }, [activeTrades]);

  const activeTotals = useMemo(() => {
    let net = 0;
    let buyAmt = 0;
    let sellAmt = 0;
    let cost = 0;
    let qty = 0;
    let buyCount = 0;
    let sellCount = 0;
    for (const t of activeTrades) {
      net += tradePnl(t, afterCost);
      buyAmt += t.buyAmt;
      sellAmt += t.sellAmt;
      cost += t.cost;
      qty += t.qty;
      buyCount += t.buys.length;
      sellCount += t.sells.length;
    }
    return {
      net,
      buyAmt,
      sellAmt,
      cost,
      qty,
      buyCount,
      sellCount,
      avgBuy: qty > 0 ? buyAmt / qty : 0,
      avgSell: qty > 0 ? sellAmt / qty : 0,
      retPct: buyAmt > 0 ? (net / buyAmt) * 100 : 0,
    };
  }, [activeTrades, afterCost]);

  const selectedNote = selectedTrade ? resolveNote(selectedTrade, notes) : null;
  const sumTone = toneClass(summary.net);
  const isAtToday = isPeriodAtToday(period, range, today);

  const triggerFlash = () => {
    setSavedFlash(true);
    window.setTimeout(() => setSavedFlash(false), 1100);
  };

  const detailMeta = useMemo(() => {
    if (resolved === null) return "";
    if (resolved.kind === "group") {
      const g = resolved.group;
      const venueTag = g.hasNxt ? "NXT · " : "";
      return `${g.code} · ${venueTag}${dayShortLabel(g.day)} ${formatMinutes(g.earliestEntryMin)}–${formatMinutes(g.latestExitMin)}`;
    }
    const t = resolved.trade;
    const venueTag = t.venue === "nxt" ? "NXT · " : "";
    const span = t.swing
      ? `${dayShortLabel(t.entryDay)} ${formatMinutes(t.entryMin)} → ${dayShortLabel(t.exitDay)} ${formatMinutes(t.exitMin)}`
      : `${dayShortLabel(t.exitDay)} ${formatMinutes(t.entryMin)}–${formatMinutes(t.exitMin)}`;
    return `${t.code} · ${venueTag}${span}`;
  }, [resolved]);

  return (
    <div ref={rootRef} className="jrn-shell">
      <header className="jrn-top">
        <div className="jrn-top-inner">
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
            <span className="jrn-step-label" data-testid="journal-period-label">
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
          <Select
            label="종목 거르기"
            className="jrn-select"
            value={filters.sym ?? ""}
            options={[
              { value: "", label: "전체 종목" },
              ...periodSymbols.map(([code, name]) => ({ value: code, label: name })),
            ]}
            onChange={(next) => setFilter("sym", next === "" ? null : next)}
          />
          <Select
            label="태그 거르기"
            className="jrn-select"
            value={filters.tag ?? ""}
            options={[
              { value: "", label: "전체 태그" },
              ...DEFAULT_TAGS.map((tg) => ({ value: tg, label: `#${tg}` })),
            ]}
            onChange={(next) => setFilter("tag", next === "" ? null : next)}
          />
          <div className="jrn-tokens" aria-label="적용된 조건">
            {extraTokens.map((tk) => (
              <button
                key={tk.key}
                type="button"
                className="jrn-tok"
                data-testid={`journal-token-${tk.key}`}
                onClick={() => clearFilter(tk.key)}
              >
                <span>{tk.label}</span>
                <span aria-hidden="true">×</span>
              </button>
            ))}
            {extraTokens.length > 0 && (
              <button type="button" className="jrn-txt-btn" onClick={() => clearFilter("*")}>
                초기화
              </button>
            )}
          </div>
          <span className="jrn-grow" />
          {isSyncingHistory && (
            <span className="jrn-mute jrn-fs-xs" data-testid="journal-sync-status">
              {pendingDays > 0 ? `동기화 중 (${pendingDays}일)` : "불러오는 중…"}
            </span>
          )}
          {historyError !== null && (
            <button type="button" className="jrn-txt-btn" data-testid="journal-retry-history" onClick={onRetryHistory}>
              {`${historyError} · 다시 시도`}
            </button>
          )}
          {demoMode && (
            <button type="button" className="jrn-txt-btn" onClick={() => setDemoMode(false)}>
              예시 닫기
            </button>
          )}
          <div className="jrn-quiet-summary" data-testid="journal-quiet-summary">
            <span>{`${summary.count}건`}</span>
            <span>·</span>
            <span>{`${summary.wins}승 ${summary.losses}패`}</span>
            <span>·</span>
            <b className={sumTone ? `jrn-${sumTone}` : ""}>{`${formatCompactWon(summary.net)} (${formatPct(summary.retPct)})`}</b>
          </div>
          <button
            type="button"
            className="jrn-route-btn"
            data-testid="journal-go-analytics"
            onClick={() => void navigate(JOURNAL_ANALYTICS_PATH)}
          >
            수익 분석 ↗
          </button>
        </div>
      </header>

      <div className="jrn-studio-page">
        <section className="jrn-studio" aria-label="타점 복기 스튜디오">
          <aside className="jrn-list-col">
            <div className="jrn-list-top">
              <span className="jrn-list-count" data-testid="journal-list-count">{`거래 ${visibleList.length}건`}</span>
              <Segmented
                label="정렬"
                mode="pressed"
                size="sm"
                value={sort}
                options={[
                  { value: "time", label: "시간" },
                  { value: "pnl", label: "손익" },
                  { value: "ret", label: "수익률" },
                ]}
                onChange={setSort}
              />
            </div>
            <div className="jrn-list-subbar">
              <div className="jrn-quick-links" role="group" aria-label="거래 형태 빠른 거르기">
                {(["all", "intraday", "swing", "scaled"] as const).map((q) => (
                  <button key={q} type="button" aria-pressed={quick === q} onClick={() => setQuick(q)}>
                    {q === "all" ? "전체" : q === "intraday" ? "당일" : q === "swing" ? "스윙" : "분할"}
                  </button>
                ))}
              </div>
            </div>

            <div className="jrn-rows" role="listbox" aria-label="라운드트립 거래 목록">
              {groups.length === 0 ? (
                <div className="jrn-empty" data-testid="journal-empty-state">
                  <p>
                    {isSyncingHistory
                      ? "체결 내역을 불러오는 중입니다"
                      : tokens.length > 0 || quick !== "all"
                        ? "조건에 맞는 거래가 없습니다"
                        : "청산한 거래가 없습니다"}
                  </p>
                  <div className="jrn-empty-actions">
                    {tokens.length > 0 || quick !== "all" ? (
                      <button type="button" className="jrn-route-btn" onClick={() => clearFilter("*")}>
                        조건 지우기
                      </button>
                    ) : (
                      !hasRealTrades && !demoMode && (
                        <button
                          type="button"
                          className="jrn-route-btn jrn-route-primary"
                          data-testid="journal-enable-demo"
                          onClick={() => setDemoMode(true)}
                        >
                          예시 데이터 체험
                        </button>
                      )
                    )}
                  </div>
                </div>
              ) : (
                groups.map((g, idx) => {
                  const prevDay = idx > 0 ? groups[idx - 1]!.day : null;
                  const showGroup = showDayHeaders && g.day !== prevDay;
                  const dayVal = daySums.get(g.day) ?? 0;
                  const pTone = toneClass(g.net);
                  const rTone = toneClass(g.retPct);
                  const isMulti = g.trades.length > 1;
                  const single = g.trades[0]!;
                  const isSelected = activeGroup?.key === g.key;
                  const [, m, d] = g.day.split("-").map(Number);

                  const singleBadge = [
                    single.venue === "nxt" ? "NXT" : "",
                    single.swing ? "스윙" : "",
                    single.styleIdx !== 0 ? STYLE_SHORT[single.styleIdx] : "",
                  ]
                    .filter(Boolean)
                    .join(" · ");

                  const multiBadge = [g.hasNxt ? "NXT" : "", g.hasSwing ? "스윙" : ""].filter(Boolean).join(" · ");
                  const prefixDay = showDayHeaders || range[0] === range[1] ? "" : `${dayShortLabel(g.day)} `;
                  const when = isMulti
                    ? `${prefixDay}${formatMinutes(g.earliestEntryMin)}–${formatMinutes(g.latestExitMin)}`
                    : single.swing
                      ? `${dayShortLabel(single.entryDay)}→${dayShortLabel(single.exitDay)}`
                      : `${prefixDay}${formatMinutes(single.entryMin)}–${formatMinutes(single.exitMin)}`;

                  const gx = (v: number) => (42 + clamp(v, -glyphCap, glyphCap) * (36 / glyphCap)).toFixed(1);

                  return (
                    <div key={g.key}>
                      {showGroup && (
                        <div className="jrn-grp">
                          <span>{`${m}월 ${d}일 ${DOW_KO[dayOfWeek(g.day)]}`}</span>
                          <span className={toneClass(dayVal) ? `jrn-${toneClass(dayVal)}` : ""}>{`${formatWon(dayVal)}원`}</span>
                        </div>
                      )}
                      <button
                        type="button"
                        role="option"
                        className="jrn-row"
                        aria-selected={isSelected}
                        data-testid={`journal-trade-row-${g.code}`}
                        data-group-key={g.key}
                        data-group-count={g.trades.length}
                        onClick={() => (isMulti ? selectGroup(g.key) : selectTrade(single.id))}
                      >
                        <span className="jrn-r-title">
                          <span className="jrn-r-name">{g.name}</span>
                          {isMulti ? (
                            <>
                              <span className="jrn-cnt-pill">{`${g.trades.length}건`}</span>
                              {multiBadge !== "" && <span className="jrn-r-badge">{multiBadge}</span>}
                            </>
                          ) : (
                            singleBadge !== "" && <span className="jrn-r-badge">{singleBadge}</span>
                          )}
                        </span>
                        <span className="jrn-r-glyph">
                          {isMulti ? (
                            <span className="jrn-wl-dots" aria-hidden="true">
                              {g.trades.map((t) => {
                                const tp = tradePnl(t, afterCost);
                                const dotTone = tp > 0 ? "up" : tp < 0 ? "dn" : "flat";
                                return <span key={t.id} className={`jrn-wl-dot jrn-wl-dot-${dotTone}`} />;
                              })}
                            </span>
                          ) : (
                            <svg width="84" height="20" aria-hidden="true">
                              <line className="jrn-g-line" x1={gx(single.mae)} x2={gx(single.mfe)} y1="10" y2="10" />
                              <line className="jrn-g-tick" x1="42" x2="42" y1="5" y2="15" />
                              <circle
                                className={single.exitRet > 0 ? "jrn-f-up" : single.exitRet < 0 ? "jrn-f-dn" : "jrn-f-flat"}
                                cx={gx(single.exitRet)}
                                cy="10"
                                r="3"
                              />
                            </svg>
                          )}
                        </span>
                        <span className={`jrn-r-pnl${pTone ? ` jrn-${pTone}` : ""}`}>{formatWon(g.net)}</span>
                        <span className="jrn-r-meta">
                          <span>{when}</span>
                          <span>{isMulti ? `${g.wins}승 ${g.losses}패` : formatHoldDuration(single)}</span>
                        </span>
                        <span className={`jrn-r-ret${rTone ? ` jrn-${rTone}` : ""}`}>{formatPct(g.retPct)}</span>
                      </button>
                    </div>
                  );
                })
              )}
            </div>
          </aside>

          <section className="jrn-detail-col" aria-label="개별 거래 타점 복기">
            {resolved === null || activeGroup === null ? (
              <div className="jrn-detail-empty">거래를 선택하면 차트와 체결 내역이 표시됩니다</div>
            ) : (
              <>
                <div className="jrn-d-head">
                  <div className="jrn-d-title">
                    <b data-testid="journal-detail-name">{activeGroup.name}</b>
                    <span className="jrn-code jrn-mono">{detailMeta}</span>
                  </div>
                  <div className="jrn-d-head-right">
                    <div className="jrn-d-pnl-pair">
                      <b className={toneClass(activeTotals.net) ? `jrn-${toneClass(activeTotals.net)}` : ""}>
                        {`${formatWon(activeTotals.net)}원`}
                      </b>
                      <span className={toneClass(activeTotals.retPct) ? `jrn-${toneClass(activeTotals.retPct)}` : ""}>
                        {formatPct(activeTotals.retPct)}
                      </span>
                    </div>
                    <Segmented
                      label="봉 주기"
                      mode="pressed"
                      size="sm"
                      value={activeTf}
                      options={JOURNAL_TFS.map(({ tf, label }) => ({ value: tf, label }))}
                      onChange={(tf) => setTf(tf)}
                    />
                  </div>
                </div>

                {activeGroup.trades.length > 1 && (
                  <div className="jrn-rt-tabs" role="group" aria-label="회차 선택" data-testid="journal-rt-tabs">
                    <button
                      type="button"
                      className="jrn-rt-tab"
                      aria-pressed={resolved.kind === "group"}
                      data-testid="journal-rt-tab-all"
                      onClick={() => selectGroup(activeGroup.key)}
                    >
                      <span>{`전체 ${activeGroup.trades.length}건`}</span>
                      <span className={toneClass(activeGroup.net) ? `jrn-${toneClass(activeGroup.net)}` : ""}>
                        {formatWon(activeGroup.net)}
                      </span>
                    </button>
                    {activeGroup.trades.map((t, idx) => {
                      const tp = tradePnl(t, afterCost);
                      const tr = tradeRetPct(t, afterCost);
                      const dotTone = tp > 0 ? "up" : tp < 0 ? "dn" : "flat";
                      const label = t.swing
                        ? `${idx + 1}회 스윙`
                        : `${idx + 1}회 ${formatMinutes(t.entryMin)}–${formatMinutes(t.exitMin)}`;
                      return (
                        <button
                          key={t.id}
                          type="button"
                          className="jrn-rt-tab"
                          aria-pressed={selectedTrade?.id === t.id}
                          data-testid={`journal-rt-tab-${idx + 1}`}
                          onClick={() => selectTrade(t.id)}
                        >
                          <span className={`jrn-wl-dot jrn-wl-dot-${dotTone}`} aria-hidden="true" />
                          <span>{label}</span>
                          <span className={toneClass(tr) ? `jrn-${toneClass(tr)}` : ""}>{formatPct(tr)}</span>
                        </button>
                      );
                    })}
                  </div>
                )}

                <dl className="jrn-d-stats">
                  <div>
                    <dt>평단 → 청산</dt>
                    <dd>{`${formatWon(activeTotals.avgBuy, false)} → ${formatWon(activeTotals.avgSell, false)}원`}</dd>
                  </div>
                  {selectedTrade !== null ? (
                    <div>
                      <dt>보유</dt>
                      <dd>{formatHoldDuration(selectedTrade)}</dd>
                    </div>
                  ) : (
                    <div>
                      <dt>승패</dt>
                      <dd>{`${activeGroup.wins}승 ${activeGroup.losses}패`}</dd>
                    </div>
                  )}
                  <div>
                    <dt>수량 · 금액</dt>
                    <dd>{`${activeTotals.qty.toLocaleString("ko-KR")}주 · ${formatCompactWon(activeTotals.buyAmt, false)}`}</dd>
                  </div>
                  {selectedTrade !== null ? (
                    <div>
                      <dt>최저 / 최고</dt>
                      <dd>
                        <span className="jrn-dn">{formatPct(selectedTrade.mae)}</span>
                        <small> / </small>
                        <span className="jrn-up">{formatPct(selectedTrade.mfe)}</span>
                      </dd>
                    </div>
                  ) : (
                    <div>
                      <dt>체결</dt>
                      <dd>{`매수 ${activeTotals.buyCount} · 매도 ${activeTotals.sellCount}`}</dd>
                    </div>
                  )}
                </dl>

                <JournalCandleChart
                  trades={activeTrades}
                  tf={activeTf}
                  today={today}
                  afterCost={afterCost}
                  highlightFill={highlightFill}
                  resetTick={resetTick}
                />

                <div className="jrn-d-foot">
                  <div>
                    <h3>
                      <span>체결 내역</span>
                      <span className="jrn-mute">
                        {`매수 ${activeTotals.buyCount} · 매도 ${activeTotals.sellCount}${
                          afterCost ? ` · 비용 ${formatWon(activeTotals.cost, false)}원` : ""
                        }`}
                      </span>
                    </h3>
                    <div className="jrn-fills" onMouseLeave={() => setHighlightFill(null)}>
                      <table>
                        <thead>
                          <tr>
                            <th>구분</th>
                            <th>시각</th>
                            <th>수량</th>
                            <th>단가</th>
                            <th>금액</th>
                          </tr>
                        </thead>
                        <tbody>
                          {fillsOfActive.map(({ fill, seq, multi, rtIdx }) => (
                            <tr
                              key={`${rtIdx}-${fill.side}-${fill.orderNo}-${seq}`}
                              data-fill-highlighted={highlightFill === fill ? "true" : undefined}
                              onMouseEnter={() => setHighlightFill(fill)}
                            >
                              <td>
                                <span className={fill.side === "sell" ? "jrn-dn" : "jrn-up"}>
                                  {`${resolved.kind === "group" ? `${rtIdx}회 ` : ""}${fill.side === "sell" ? "▼ 매도" : "▲ 매수"}${multi ? seq : ""}`}
                                </span>
                              </td>
                              <td className="jrn-mute">
                                {fill.day !== activeGroup.day ? `${dayShortLabel(fill.day)} ${fill.timeLabel}` : fill.timeLabel}
                              </td>
                              <td>{fill.qty.toLocaleString("ko-KR")}</td>
                              <td>{formatWon(fill.price, false)}</td>
                              <td className="jrn-mute">{formatWon(fill.price * fill.qty, false)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>

                  <div className="jrn-memo-area">
                    {selectedTrade !== null ? (
                      <>
                        <h3>
                          <label htmlFor="journal-memo-input">복기 메모 · 태그</label>
                          <span className={`jrn-save-ind${savedFlash ? " on" : ""}`}>저장됨</span>
                        </h3>
                        <div className="jrn-memo-tags">
                          {DEFAULT_TAGS.map((tg) => {
                            const active = selectedNote?.tags.includes(tg) ?? false;
                            return (
                              <button
                                key={tg}
                                type="button"
                                className="jrn-m-tag"
                                aria-pressed={active}
                                onClick={() => {
                                  toggleTradeTag(selectedTrade.id, tg, selectedTrade.defaultMemo, selectedTrade.defaultTags);
                                  triggerFlash();
                                }}
                              >
                                {`#${tg}`}
                              </button>
                            );
                          })}
                        </div>
                        <textarea
                          id="journal-memo-input"
                          data-testid="journal-memo-input"
                          placeholder="복기 메모"
                          value={selectedNote?.memo ?? ""}
                          onChange={(e) => {
                            saveMemo(selectedTrade.id, e.target.value, selectedTrade.defaultTags);
                            triggerFlash();
                          }}
                        />
                      </>
                    ) : (
                      <>
                        <h3>
                          <span>회차별 메모</span>
                          <span className="jrn-mute">{`${activeGroup.trades.length}건`}</span>
                        </h3>
                        <div className="jrn-group-memos" data-testid="journal-group-memos">
                          {activeGroup.trades.map((t, idx) => {
                            const n = resolveNote(t, notes);
                            const tr = tradeRetPct(t, afterCost);
                            const text = n.memo || n.tags.map((x) => `#${x}`).join(" ");
                            return (
                              <button
                                key={t.id}
                                type="button"
                                className="jrn-group-memo-item"
                                onClick={() => selectTrade(t.id)}
                              >
                                <span className="jrn-gm-head">
                                  <b>{`${idx + 1}회 · ${formatMinutes(t.entryMin)}–${formatMinutes(t.exitMin)}`}</b>
                                  <span className={toneClass(tr) ? `jrn-${toneClass(tr)}` : ""}>{formatPct(tr)}</span>
                                </span>
                                <span className={text !== "" ? "jrn-gm-body" : "jrn-gm-empty"}>
                                  {text !== "" ? text : "메모 작성"}
                                </span>
                              </button>
                            );
                          })}
                        </div>
                      </>
                    )}
                  </div>
                </div>
              </>
            )}
          </section>
        </section>

        <JournalWhereSection
          periodTrades={periodTrades}
          filteredListCount={visibleList.length}
          onScrollTop={() => {
            rootRef.current?.closest(".page-stage")?.scrollTo({ top: 0, behavior: "smooth" });
          }}
        />
      </div>
    </div>
  );
}
