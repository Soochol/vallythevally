import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { Select } from "../menu/Select";
import { ownsChartKeyboard } from "../overlay/topLayer";
import { JOURNAL_ANALYTICS_PATH } from "../page-rail/pages";
import { Segmented } from "../ui/Segmented";
import { JournalCandleChart } from "./JournalCandleChart";
import {
  activeFilterTokens,
  autoTfOf,
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
  STYLE_LABELS,
  STYLE_SHORT,
  type JournalFill,
  type JournalSummary,
  type JournalTrade,
} from "./journalTypes";
import { JournalWhereSection } from "./JournalWhereSection";

interface Props {
  readonly allTrades: readonly JournalTrade[];
  readonly periodTrades: readonly JournalTrade[];
  readonly filteredTrades: readonly JournalTrade[];
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

export function JournalStudioView({
  allTrades,
  periodTrades,
  filteredTrades,
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
  const selectedId = useJournalStore((s) => s.selectedId);
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

  const sortedList = useMemo(() => {
    const copy = visibleList.slice();
    const keyVal =
      sort === "time"
        ? (t: JournalTrade) => t.exitOrd
        : sort === "pnl"
          ? (t: JournalTrade) => tradePnl(t, afterCost)
          : (t: JournalTrade) => tradeRetPct(t, afterCost);
    copy.sort((a, b) => (keyVal(a) - keyVal(b)) * sortDir);
    return copy;
  }, [visibleList, sort, sortDir, afterCost]);

  const selectedTrade = useMemo(
    () => sortedList.find((t) => t.id === selectedId) ?? sortedList[0] ?? null,
    [sortedList, selectedId],
  );

  const activeTf = selectedTrade ? tfOverride ?? autoTfOf(selectedTrade) : "1";

  const glyphCap = useMemo(() => {
    if (sortedList.length === 0) return 5;
    const reaches = sortedList.map((t) => Math.max(t.mfe, -t.mae, Math.abs(t.exitRet))).sort((a, b) => a - b);
    return Math.max(1.2, reaches[Math.floor((reaches.length - 1) * 0.9)] ?? 5);
  }, [sortedList]);

  const grouped = sort === "time" && range[0] !== range[1];
  const daySums = useMemo(() => {
    const map = new Map<string, number>();
    if (!grouped) return map;
    for (const t of sortedList) map.set(t.exitDay, (map.get(t.exitDay) ?? 0) + tradePnl(t, afterCost));
    return map;
  }, [sortedList, grouped, afterCost]);

  const tokens = useMemo(() => activeFilterTokens(filters, symbolNames), [filters, symbolNames]);
  const extraTokens = useMemo(() => tokens.filter((t) => t.key !== "sym" && t.key !== "tag"), [tokens]);

  useEffect(() => {
    setHighlightFill(null);
  }, [selectedTrade?.id]);

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
      if ((e.key === "ArrowDown" || e.key === "j" || e.key === "ArrowUp" || e.key === "k") && sortedList.length > 0) {
        e.preventDefault();
        const curIdx = sortedList.findIndex((t) => t.id === selectedTrade?.id);
        const delta = e.key === "ArrowDown" || e.key === "j" ? 1 : -1;
        const nextIdx = clamp((curIdx < 0 ? 0 : curIdx) + delta, 0, sortedList.length - 1);
        selectTrade(sortedList[nextIdx]!.id);
      } else if (e.key === "1" || e.key === "3" || e.key === "5" || e.key.toLowerCase() === "d") {
        setTf(e.key.toUpperCase() as "1" | "3" | "5" | "D");
      } else if (e.key === "0") {
        setResetTick((v) => v + 1);
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [sortedList, selectedTrade?.id, clearFilter, selectTrade, setTf]);

  const fillsOfSelected = useMemo(() => {
    if (selectedTrade === null) return [];
    return [
      ...selectedTrade.buys.map((f, i) => ({ fill: f, seq: i + 1, multi: selectedTrade.buys.length > 1 })),
      ...selectedTrade.sells.map((f, i) => ({ fill: f, seq: i + 1, multi: selectedTrade.sells.length > 1 })),
    ].sort((a, b) => a.fill.day.localeCompare(b.fill.day) || a.fill.minutes - b.fill.minutes);
  }, [selectedTrade]);

  const selectedNote = selectedTrade ? resolveNote(selectedTrade, notes) : null;
  const sumTone = toneClass(summary.net);
  const isAtToday = isPeriodAtToday(period, range, today);

  const triggerFlash = () => {
    setSavedFlash(true);
    window.setTimeout(() => setSavedFlash(false), 1100);
  };

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
              {pendingDays > 0 ? `과거 체결 불러오는 중 (${pendingDays}일 남음)` : "체결 불러오는 중…"}
            </span>
          )}
          {historyError !== null && (
            <button type="button" className="jrn-txt-btn" data-testid="journal-retry-history" onClick={onRetryHistory}>
              {`${historyError} · 다시 시도`}
            </button>
          )}
          {demoMode && (
            <button type="button" className="jrn-txt-btn" onClick={() => setDemoMode(false)}>
              예시 데이터 닫기
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
              <span className="jrn-list-count" data-testid="journal-list-count">{`거래 ${sortedList.length}건`}</span>
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
              {quick !== "all" && (
                <span className="jrn-mute jrn-fs-xs">{`필터 전 ${filteredTrades.length}건`}</span>
              )}
            </div>
            <div className="jrn-glyph-legend">
              <svg width="52" height="12" aria-hidden="true">
                <line className="jrn-g-line" x1="6" x2="46" y1="6" y2="6" />
                <line className="jrn-g-tick" x1="24" x2="24" y1="2" y2="10" />
                <circle className="jrn-f-up" cx="38" cy="6" r="3" />
              </svg>
              <span>보유 중 최저~최고 · 눈금 평단 · 점 청산</span>
            </div>

            <div className="jrn-rows" role="listbox" aria-label="라운드트립 거래 목록">
              {sortedList.length === 0 ? (
                <div className="jrn-empty" data-testid="journal-empty-state">
                  <p>
                    {isSyncingHistory
                      ? "이 기간의 체결 내역을 불러오는 중입니다"
                      : tokens.length > 0 || quick !== "all"
                        ? "이 조건에 맞는 거래가 없습니다"
                        : "이 기간에 청산한 거래가 없습니다"}
                  </p>
                  <div className="jrn-empty-actions">
                    {tokens.length > 0 || quick !== "all" ? (
                      <button type="button" className="jrn-route-btn" onClick={() => clearFilter("*")}>
                        조건 모두 지우기
                      </button>
                    ) : (
                      <>
                        {!hasRealTrades && !demoMode && (
                          <button
                            type="button"
                            className="jrn-route-btn jrn-route-primary"
                            data-testid="journal-enable-demo"
                            onClick={() => setDemoMode(true)}
                          >
                            예시 데이터로 체험
                          </button>
                        )}
                      </>
                    )}
                  </div>
                </div>
              ) : (
                sortedList.map((t, idx) => {
                  const prevDay = idx > 0 ? sortedList[idx - 1]!.exitDay : null;
                  const showGroup = grouped && t.exitDay !== prevDay;
                  const dayVal = daySums.get(t.exitDay) ?? 0;
                  const p = tradePnl(t, afterCost);
                  const r = tradeRetPct(t, afterCost);
                  const pTone = toneClass(p);
                  const rTone = toneClass(r);
                  const note = resolveNote(t, notes);
                  const preview = note.memo || note.tags.slice(0, 2).map((x) => `#${x}`).join(" ");
                  const when = t.swing
                    ? `${dayShortLabel(t.entryDay)}→${dayShortLabel(t.exitDay)}`
                    : `${grouped || range[0] === range[1] ? "" : `${dayShortLabel(t.exitDay)} `}${formatMinutes(t.entryMin)}–${formatMinutes(t.exitMin)}`;
                  const badge = [
                    t.venue === "nxt" ? "NXT" : "",
                    t.swing ? "스윙" : "",
                    t.styleIdx !== 0 ? STYLE_SHORT[t.styleIdx] : "",
                  ]
                    .filter(Boolean)
                    .join(" · ");

                  const gx = (v: number) => (42 + clamp(v, -glyphCap, glyphCap) * (36 / glyphCap)).toFixed(1);
                  const [, m, d] = t.exitDay.split("-").map(Number);

                  return (
                    <div key={t.id}>
                      {showGroup && (
                        <div className="jrn-grp">
                          <span>{`${m}월 ${d}일 ${DOW_KO[dayOfWeek(t.exitDay)]}`}</span>
                          <span className={toneClass(dayVal) ? `jrn-${toneClass(dayVal)}` : ""}>{`${formatWon(dayVal)}원`}</span>
                        </div>
                      )}
                      <button
                        type="button"
                        role="option"
                        className="jrn-row"
                        aria-selected={selectedTrade?.id === t.id}
                        data-testid={`journal-trade-row-${t.code}`}
                        onClick={() => selectTrade(t.id)}
                      >
                        <span className="jrn-r-title">
                          <span className="jrn-r-name">{t.name}</span>
                          {badge !== "" && <span className="jrn-r-badge">{badge}</span>}
                        </span>
                        <span className="jrn-r-glyph">
                          <svg width="84" height="20" aria-hidden="true">
                            <line className="jrn-g-line" x1={gx(t.mae)} x2={gx(t.mfe)} y1="10" y2="10" />
                            <line className="jrn-g-tick" x1="42" x2="42" y1="5" y2="15" />
                            <circle className={t.exitRet > 0 ? "jrn-f-up" : t.exitRet < 0 ? "jrn-f-dn" : "jrn-f-flat"} cx={gx(t.exitRet)} cy="10" r="3" />
                          </svg>
                        </span>
                        <span className={`jrn-r-pnl${pTone ? ` jrn-${pTone}` : ""}`}>{formatWon(p)}</span>
                        <span className="jrn-r-meta">
                          <span>{when}</span>
                          <span>{formatHoldDuration(t)}</span>
                          {preview !== "" && <u>{preview}</u>}
                        </span>
                        <span className={`jrn-r-ret${rTone ? ` jrn-${rTone}` : ""}`}>{formatPct(r)}</span>
                      </button>
                    </div>
                  );
                })
              )}
            </div>

            <div className="jrn-keys">
              <span><kbd>↑</kbd><kbd>↓</kbd>이동</span>
              <span><kbd>1</kbd><kbd>3</kbd><kbd>5</kbd><kbd>D</kbd>봉 주기</span>
              <span><kbd>0</kbd>맞춤</span>
              <span><kbd>Esc</kbd>조건 해제</span>
            </div>
          </aside>

          <section className="jrn-detail-col" aria-label="개별 거래 타점 복기">
            {selectedTrade === null ? (
              <div className="jrn-detail-empty">거래를 선택하면 타점 차트와 체결 내역이 표시됩니다</div>
            ) : (
              <>
                <div className="jrn-d-head">
                  <div className="jrn-d-title">
                    <b data-testid="journal-detail-name">{selectedTrade.name}</b>
                    <span className="jrn-code jrn-mono">
                      {`${selectedTrade.code} · ${selectedTrade.venue} · ${
                        selectedTrade.swing
                          ? `${dayShortLabel(selectedTrade.entryDay)} ${formatMinutes(selectedTrade.entryMin)} → ${dayShortLabel(selectedTrade.exitDay)} ${formatMinutes(selectedTrade.exitMin)}`
                          : `${selectedTrade.exitDay} · ${formatMinutes(selectedTrade.entryMin)}–${formatMinutes(selectedTrade.exitMin)}`
                      }`}
                    </span>
                  </div>
                  <div className="jrn-d-head-right">
                    <div className="jrn-d-pnl-pair">
                      <b className={toneClass(tradePnl(selectedTrade, afterCost)) ? `jrn-${toneClass(tradePnl(selectedTrade, afterCost))}` : ""}>
                        {`${formatWon(tradePnl(selectedTrade, afterCost))}원`}
                      </b>
                      <span className={toneClass(tradeRetPct(selectedTrade, afterCost)) ? `jrn-${toneClass(tradeRetPct(selectedTrade, afterCost))}` : ""}>
                        {formatPct(tradeRetPct(selectedTrade, afterCost))}
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

                <dl className="jrn-d-stats">
                  <div>
                    <dt>평균 매입 → 청산</dt>
                    <dd>{`${formatWon(selectedTrade.avgBuy, false)} → ${formatWon(selectedTrade.avgSell, false)}원`}</dd>
                  </div>
                  <div>
                    <dt>보유 기간</dt>
                    <dd>{formatHoldDuration(selectedTrade)}</dd>
                  </div>
                  <div>
                    <dt>수량 · 투입</dt>
                    <dd>{`${selectedTrade.qty.toLocaleString("ko-KR")}주 · ${formatCompactWon(selectedTrade.buyAmt, false)}`}</dd>
                  </div>
                  <div>
                    <dt>진입 방식</dt>
                    <dd>{STYLE_LABELS[selectedTrade.styleIdx]}</dd>
                  </div>
                  <div>
                    <dt>보유 중 최저 / 최고</dt>
                    <dd>
                      <span className="jrn-dn">{formatPct(selectedTrade.mae)}</span>
                      <small> / </small>
                      <span className="jrn-up">{formatPct(selectedTrade.mfe)}</span>
                    </dd>
                  </div>
                </dl>

                <JournalCandleChart
                  trade={selectedTrade}
                  tf={activeTf}
                  today={today}
                  isAutoTf={tfOverride === null}
                  afterCost={afterCost}
                  highlightFill={highlightFill}
                  resetTick={resetTick}
                />

                <div className="jrn-d-foot">
                  <div>
                    <h3>
                      <span>체결 내역</span>
                      <span className="jrn-mute">행에 올리면 해당 봉 강조</span>
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
                          {fillsOfSelected.map(({ fill, seq, multi }) => (
                            <tr
                              key={`${fill.side}-${fill.orderNo}-${seq}`}
                              onMouseEnter={() => setHighlightFill(fill)}
                            >
                              <td>
                                <span className={fill.side === "sell" ? "jrn-dn" : "jrn-up"}>
                                  {`${fill.side === "sell" ? "▼ 매도" : "▲ 매수"}${multi ? seq : ""}`}
                                </span>
                              </td>
                              <td className="jrn-mute">
                                {selectedTrade.swing ? `${dayShortLabel(fill.day)} ${fill.timeLabel}` : fill.timeLabel}
                              </td>
                              <td>{fill.qty.toLocaleString("ko-KR")}</td>
                              <td>{formatWon(fill.price, false)}</td>
                              <td className="jrn-mute">{formatWon(fill.price * fill.qty, false)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <div className="jrn-fills-foot">
                      <span>{`매입 ${formatWon(selectedTrade.buyAmt, false)} · 매도 ${formatWon(selectedTrade.sellAmt, false)} · 비용 ${afterCost ? `${formatWon(selectedTrade.cost, false)}원` : "제외"}`}</span>
                      <b className={toneClass(tradePnl(selectedTrade, afterCost)) ? `jrn-${toneClass(tradePnl(selectedTrade, afterCost))}` : ""}>
                        {`${formatWon(tradePnl(selectedTrade, afterCost))}원 (${formatPct(tradeRetPct(selectedTrade, afterCost))})`}
                      </b>
                    </div>
                  </div>

                  <div className="jrn-memo-area">
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
                      placeholder="진입·청산 근거를 남겨 두세요. 입력하면 즉시 저장됩니다."
                      value={selectedNote?.memo ?? ""}
                      onChange={(e) => {
                        saveMemo(selectedTrade.id, e.target.value, selectedTrade.defaultTags);
                        triggerFlash();
                      }}
                    />
                  </div>
                </div>
              </>
            )}
          </section>
        </section>

        <JournalWhereSection
          periodTrades={periodTrades}
          filteredListCount={sortedList.length}
          onScrollTop={() => {
            rootRef.current?.closest(".page-stage")?.scrollTo({ top: 0, behavior: "smooth" });
          }}
        />
      </div>
    </div>
  );
}
