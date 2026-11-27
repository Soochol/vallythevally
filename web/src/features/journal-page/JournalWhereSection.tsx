import { useMemo, useState } from "react";
import {
  formatCompactWon,
  formatPct,
  matchTradeFilter,
  metricValueOf,
  resolveNote,
  retBucketOf,
  slotIdxOf,
  toneClass,
  tradePnl,
  tradeRetPct,
} from "./journalEngine";
import { useJournalStore } from "./journalStore";
import {
  DEFAULT_TAGS,
  HOLD_LABELS,
  PAIRS,
  RET_FULL,
  RET_LABELS,
  SESSIONS,
  STYLE_LABELS,
  type JournalFilterKey,
  type JournalTrade,
} from "./journalTypes";

interface Props {
  readonly periodTrades: readonly JournalTrade[];
  readonly filteredListCount: number;
  readonly onScrollTop: () => void;
}

interface DivRowProps {
  readonly label: string;
  readonly sub: string;
  readonly val: number;
  readonly maxAbs: number;
  readonly mainText: string;
  readonly secText: string;
  readonly isCount: boolean;
  readonly active: boolean;
  readonly onClick: () => void;
  readonly testId?: string;
}

function DivergingRow({ label, sub, val, maxAbs, mainText, secText, isCount, active, onClick, testId }: DivRowProps) {
  const widthPct = maxAbs > 0 && val !== 0 ? Math.max(4, Math.min(100, (Math.abs(val) / maxAbs) * 100)) : 0;
  const isPos = val >= 0;
  const tone = isCount ? "" : toneClass(val);
  return (
    <button
      type="button"
      className="jrn-div-row"
      aria-pressed={active}
      data-testid={testId}
      onClick={onClick}
    >
      <div className="jrn-div-l">
        <span className="jrn-div-name">{label}</span>
        {sub !== "" && <span className="jrn-div-sub">{sub}</span>}
      </div>
      <div className="jrn-div-track">
        <div className="jrn-div-neg">
          {!isCount && !isPos && val !== 0 && <div className="jrn-div-bar-neg" style={{ width: `${widthPct.toFixed(1)}%` }} />}
        </div>
        <div className="jrn-div-pos">
          {isCount && val > 0 ? (
            <div className="jrn-div-bar-ink" style={{ width: `${widthPct.toFixed(1)}%` }} />
          ) : (
            !isCount && isPos && val !== 0 && <div className="jrn-div-bar-pos" style={{ width: `${widthPct.toFixed(1)}%` }} />
          )}
        </div>
      </div>
      <div className="jrn-div-r">
        <span className={`jrn-div-main${tone ? ` jrn-${tone}` : ""}`}>{mainText}</span>
        {secText !== "" && <span className="jrn-div-sec">{secText}</span>}
      </div>
    </button>
  );
}

export function JournalWhereSection({ periodTrades, filteredListCount, onScrollTop }: Props) {
  const filters = useJournalStore((s) => s.filters);
  const afterCost = useJournalStore((s) => s.afterCost);
  const metric = useJournalStore((s) => s.metric);
  const distMode = useJournalStore((s) => s.distMode);
  const notes = useJournalStore((s) => s.notes);
  const setMetric = useJournalStore((s) => s.setMetric);
  const setDistMode = useJournalStore((s) => s.setDistMode);
  const toggleFilter = useJournalStore((s) => s.toggleFilter);

  const [hoveredRetIdx, setHoveredRetIdx] = useState<number | null>(null);

  const isCount = metric === "n";
  const hasAnyFilter = Object.values(filters).some((v) => v !== null);

  const fmtMain = (n: number, p: number, b: number) =>
    n === 0 ? "—" : metric === "pnl" ? formatCompactWon(p) : metric === "ret" ? formatPct(b > 0 ? (p / b) * 100 : 0) : `${n}건`;
  const fmtSec = (n: number, p: number, b: number) =>
    n === 0 ? "" : metric === "pnl" ? formatPct(b > 0 ? (p / b) * 100 : 0) : formatCompactWon(p);

  const tradesExcept = (except: JournalFilterKey) =>
    periodTrades.filter((t) => matchTradeFilter(t, filters, notes, afterCost, except));

  const sessionCounts = useMemo(() => {
    const counts = SESSIONS.map((s, idx) => ({ ...s, idx, buys: 0, sells: 0 }));
    for (const t of tradesExcept("slot")) {
      for (const f of t.buys) counts[slotIdxOf(f.minutes, t.venue)]!.buys += 1;
      for (const f of t.sells) counts[slotIdxOf(f.minutes, t.venue)]!.sells += 1;
    }
    const maxCnt = Math.max(3, ...counts.map((c) => Math.max(c.buys, c.sells)));
    return { counts, maxCnt };
  }, [periodTrades, filters, notes, afterCost]);

  const pairRows = useMemo(() => {
    const groups = PAIRS.map((p, idx) => ({ ...p, idx, n: 0, w: 0, p: 0, b: 0 }));
    for (const t of tradesExcept("pair")) {
      const g = groups[t.pairIdx]!;
      const tp = tradePnl(t, afterCost);
      g.n += 1;
      g.p += tp;
      g.b += t.buyAmt;
      if (tp > 0) g.w += 1;
    }
    const visible = groups.filter((g) => g.n > 0 || filters.pair === g.idx);
    const maxAbs = Math.max(1e-6, ...visible.map((g) => Math.abs(metricValueOf(g.p, g.b, g.n, metric))));
    return { visible, maxAbs };
  }, [periodTrades, filters, notes, afterCost, metric]);

  const holdStats = useMemo(() => {
    const groups = HOLD_LABELS.map((label, idx) => ({ label, idx, n: 0, w: 0, p: 0, b: 0 }));
    let winM = 0;
    let winN = 0;
    let lossM = 0;
    let lossN = 0;
    let swD = 0;
    let swN = 0;
    for (const t of tradesExcept("hold")) {
      const g = groups[t.holdBucket]!;
      const tp = tradePnl(t, afterCost);
      g.n += 1;
      g.p += tp;
      g.b += t.buyAmt;
      if (tp > 0) g.w += 1;
      if (t.swing) {
        swD += t.holdDays;
        swN += 1;
      } else if (tp > 0) {
        winM += t.holdMin;
        winN += 1;
      } else if (tp < 0) {
        lossM += t.holdMin;
        lossN += 1;
      }
    }
    const maxAbs = Math.max(1e-6, ...groups.map((g) => Math.abs(metricValueOf(g.p, g.b, g.n, metric))));
    return {
      groups,
      maxAbs,
      avgWinMin: winN > 0 ? Math.round(winM / winN) : null,
      avgLossMin: lossN > 0 ? Math.round(lossM / lossN) : null,
      avgSwingDays: swN > 0 ? (swD / swN).toFixed(1) : null,
    };
  }, [periodTrades, filters, notes, afterCost, metric]);

  const retBuckets = useMemo(() => {
    const groups = RET_LABELS.map((label, idx) => ({ label, idx, n: 0, p: 0, b: 0 }));
    for (const t of tradesExcept("ret")) {
      const g = groups[retBucketOf(tradeRetPct(t, afterCost))]!;
      g.n += 1;
      g.p += tradePnl(t, afterCost);
      g.b += t.buyAmt;
    }
    const vals = groups.map((g) => metricValueOf(g.p, g.b, g.n, metric));
    const mp = Math.max(0, ...vals);
    const mn = Math.max(0, ...vals.map((v) => -v));
    const H = 136;
    const sc = mp + mn > 0 ? H / (mp + mn) : 0;
    const base = mp + mn > 0 ? mp * sc : H;
    return { groups, vals, sc, base };
  }, [periodTrades, filters, notes, afterCost, metric]);

  const styleRows = useMemo(() => {
    const groups = STYLE_LABELS.map((label, idx) => ({ label, idx, n: 0, w: 0, p: 0, b: 0 }));
    for (const t of tradesExcept("style")) {
      const g = groups[t.styleIdx]!;
      const tp = tradePnl(t, afterCost);
      g.n += 1;
      g.p += tp;
      g.b += t.buyAmt;
      if (tp > 0) g.w += 1;
    }
    const maxAbs = Math.max(1e-6, ...groups.map((g) => Math.abs(metricValueOf(g.p, g.b, g.n, metric))));
    return { groups, maxAbs };
  }, [periodTrades, filters, notes, afterCost, metric]);

  const tagStats = useMemo(() => {
    const map = new Map<string, { tag: string; n: number; p: number }>(
      DEFAULT_TAGS.map((tg) => [tg, { tag: tg, n: 0, p: 0 }]),
    );
    for (const t of tradesExcept("tag")) {
      const tp = tradePnl(t, afterCost);
      for (const tg of resolveNote(t, notes).tags) {
        const cur = map.get(tg) ?? { tag: tg, n: 0, p: 0 };
        cur.n += 1;
        cur.p += tp;
        map.set(tg, cur);
      }
    }
    return [...map.values()]
      .filter((x) => x.n > 0 || filters.tag === x.tag)
      .sort((a, b) => b.n - a.n);
  }, [periodTrades, filters, notes, afterCost]);

  const symRows = useMemo(() => {
    const map = new Map<string, { code: string; name: string; n: number; w: number; p: number; b: number }>();
    for (const t of tradesExcept("sym")) {
      const cur = map.get(t.code) ?? { code: t.code, name: t.name, n: 0, w: 0, p: 0, b: 0 };
      const tp = tradePnl(t, afterCost);
      cur.n += 1;
      cur.p += tp;
      cur.b += t.buyAmt;
      if (tp > 0) cur.w += 1;
      map.set(t.code, cur);
    }
    const list = [...map.values()].sort(
      (a, b) => metricValueOf(b.p, b.b, b.n, metric) - metricValueOf(a.p, a.b, a.n, metric),
    );
    const maxAbs = Math.max(1e-6, ...list.map((g) => Math.abs(metricValueOf(g.p, g.b, g.n, metric))));
    return { list, maxAbs };
  }, [periodTrades, filters, notes, afterCost, metric]);

  const activeRetIdx = hoveredRetIdx ?? filters.ret;
  const retReadout =
    activeRetIdx !== null && retBuckets.groups[activeRetIdx]
      ? `${RET_FULL[activeRetIdx]} · ${retBuckets.groups[activeRetIdx]!.n}건 · ${formatCompactWon(retBuckets.groups[activeRetIdx]!.p)}`
      : "막대에 올리거나 눌러서 구간을 선택하세요";

  return (
    <section className="jrn-where" data-testid="journal-where-section" aria-label="매매 패턴 및 조건 분해">
      <div className="jrn-band-head">
        <h2 className="jrn-band-title">어디서 벌고 잃었나</h2>
        <span className="jrn-band-cap">막대나 항목을 누르면 바로 위 타점 복기 목록·차트가 즉시 필터 연동됩니다</span>
        <span className="jrn-grow" />
        {hasAnyFilter && (
          <button
            type="button"
            className="jrn-route-btn"
            data-testid="journal-where-jump-top"
            onClick={onScrollTop}
          >
            {`↑ 필터된 ${filteredListCount}건 타점 보기`}
          </button>
        )}
        <div className="jrn-seg" role="group" aria-label="비교 기준">
          <button type="button" aria-pressed={metric === "pnl"} onClick={() => setMetric("pnl")}>손익</button>
          <button type="button" aria-pressed={metric === "ret"} onClick={() => setMetric("ret")}>수익률</button>
          <button type="button" aria-pressed={metric === "n"} onClick={() => setMetric("n")}>건수</button>
        </div>
      </div>

      <div className="jrn-an-row-1">
        <div>
          <div className="jrn-fc-head">
            <span className="jrn-fc-title">시간대별 매수 · 매도 체결 횟수</span>
            <div className="jrn-fc-meta">
              <span><i className="jrn-lg-dot jrn-bg-up" />매수</span>
              <span><i className="jrn-lg-dot jrn-bg-dn" />매도</span>
            </div>
          </div>
          <div className={`jrn-bs-grid${filters.slot !== null ? " jrn-has-sel" : ""}`} data-testid="journal-session-grid">
            {sessionCounts.counts.map((s) => {
              const bh = s.buys > 0 ? Math.max(6, Math.round((s.buys / sessionCounts.maxCnt) * 114)) : 0;
              const sh = s.sells > 0 ? Math.max(6, Math.round((s.sells / sessionCounts.maxCnt) * 114)) : 0;
              return (
                <button
                  key={s.key}
                  type="button"
                  className="jrn-bs-col"
                  aria-pressed={filters.slot === s.idx}
                  aria-label={`${s.label} 매수 ${s.buys}회 매도 ${s.sells}회`}
                  onClick={() => toggleFilter("slot", s.idx)}
                >
                  <div className="jrn-bs-bars">
                    <div className="jrn-bs-pair">
                      {s.buys > 0 && (
                        <>
                          <span className="jrn-bs-num jrn-up">{s.buys}</span>
                          <span className="jrn-bs-bar jrn-bg-up" style={{ height: `${bh}px` }} />
                        </>
                      )}
                    </div>
                    <div className="jrn-bs-pair">
                      {s.sells > 0 && (
                        <>
                          <span className="jrn-bs-num jrn-dn">{s.sells}</span>
                          <span className="jrn-bs-bar jrn-bg-dn" style={{ height: `${sh}px` }} />
                        </>
                      )}
                    </div>
                  </div>
                  <span className="jrn-bs-t">{s.short}</span>
                  <span className="jrn-bs-v">
                    <span className="jrn-up">{s.buys}</span>/<span className="jrn-dn">{s.sells}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        <div>
          <div className="jrn-fc-head">
            <span className="jrn-fc-title">진입 → 청산 시간대 패턴</span>
            <span className="jrn-fc-meta">
              {isCount ? "건수 기준" : metric === "ret" ? "0% 기준 평균 수익률" : "0원 기준 실현손익"}
            </span>
          </div>
          <div className={`jrn-div-list${filters.pair !== null ? " jrn-has-sel" : ""}`} data-testid="journal-pair-list">
            {pairRows.visible.length === 0 ? (
              <span className="jrn-mute">거래 없음</span>
            ) : (
              pairRows.visible.map((g) => (
                <DivergingRow
                  key={g.key}
                  label={g.label}
                  sub={`${g.n}건 · 승률 ${g.n > 0 ? Math.round((g.w / g.n) * 100) : 0}%`}
                  val={metricValueOf(g.p, g.b, g.n, metric)}
                  maxAbs={pairRows.maxAbs}
                  mainText={fmtMain(g.n, g.p, g.b)}
                  secText={fmtSec(g.n, g.p, g.b)}
                  isCount={isCount}
                  active={filters.pair === g.idx}
                  testId={`journal-pair-${g.key}`}
                  onClick={() => toggleFilter("pair", g.idx)}
                />
              ))
            )}
          </div>
        </div>
      </div>

      <div className="jrn-an-row-2">
        <div>
          <div className="jrn-fc-head">
            <div className="jrn-seg jrn-seg-quiet" role="group" aria-label="구간 분해 전환">
              <button type="button" aria-pressed={distMode === "hold"} onClick={() => setDistMode("hold")}>보유 기간</button>
              <button type="button" aria-pressed={distMode === "ret"} onClick={() => setDistMode("ret")}>수익률 구간</button>
            </div>
            <span className="jrn-fc-meta">{distMode === "hold" ? "보유 시간 기준" : "거래별 수익률 분포"}</span>
          </div>

          {distMode === "hold" ? (
            <>
              <div className="jrn-fact-strip">
                <div>
                  <span>당일 수익 평균</span>
                  <b className="jrn-up">{holdStats.avgWinMin !== null ? `${holdStats.avgWinMin}분` : "—"}</b>
                </div>
                <div>
                  <span>당일 손실 평균</span>
                  <b className="jrn-dn">{holdStats.avgLossMin !== null ? `${holdStats.avgLossMin}분` : "—"}</b>
                </div>
                <div>
                  <span>스윙 평균</span>
                  <b>{holdStats.avgSwingDays !== null ? `${holdStats.avgSwingDays}거래일` : "—"}</b>
                </div>
              </div>
              <div className={`jrn-div-list${filters.hold !== null ? " jrn-has-sel" : ""}`}>
                {holdStats.groups.map((g) => (
                  <DivergingRow
                    key={g.label}
                    label={g.label}
                    sub={`${g.n}건`}
                    val={metricValueOf(g.p, g.b, g.n, metric)}
                    maxAbs={holdStats.maxAbs}
                    mainText={fmtMain(g.n, g.p, g.b)}
                    secText={fmtSec(g.n, g.p, g.b)}
                    isCount={isCount}
                    active={filters.hold === g.idx}
                    onClick={() => toggleFilter("hold", g.idx)}
                  />
                ))}
              </div>
            </>
          ) : (
            <>
              <div
                className={`jrn-vb${filters.ret !== null ? " jrn-has-sel" : ""}`}
                style={{ ["--jrn-base" as string]: `${retBuckets.base.toFixed(1)}px` }}
              >
                {retBuckets.groups.map((g, i) => {
                  const v = retBuckets.vals[i]!;
                  const h = v !== 0 ? Math.max(3, Math.abs(v) * retBuckets.sc) : 0;
                  const tone = isCount ? "jrn-mute" : toneClass(v) ? `jrn-${toneClass(v)}` : "";
                  return (
                    <button
                      key={g.idx}
                      type="button"
                      className={`jrn-vb-col ${tone}`}
                      aria-pressed={filters.ret === i}
                      aria-label={`${RET_FULL[i]} ${g.n}건`}
                      onMouseEnter={() => setHoveredRetIdx(i)}
                      onMouseLeave={() => setHoveredRetIdx(null)}
                      onClick={() => toggleFilter("ret", i)}
                    >
                      <i style={{ top: `${(v >= 0 ? retBuckets.base - h : retBuckets.base).toFixed(1)}px`, height: `${h.toFixed(1)}px` }} />
                      <span>{g.label}</span>
                    </button>
                  );
                })}
              </div>
              <div className="jrn-vb-readout">{retReadout}</div>
            </>
          )}
        </div>

        <div>
          <div className="jrn-fc-head">
            <span className="jrn-fc-title">진입 방식</span>
            <span className="jrn-fc-meta">라운드트립 분할 단가 기준</span>
          </div>
          <div className={`jrn-div-list${filters.style !== null ? " jrn-has-sel" : ""}`}>
            {styleRows.groups.map((g) => (
              <DivergingRow
                key={g.label}
                label={g.label}
                sub={`${g.n}건 · ${g.w}승 ${g.n - g.w}패`}
                val={metricValueOf(g.p, g.b, g.n, metric)}
                maxAbs={styleRows.maxAbs}
                mainText={fmtMain(g.n, g.p, g.b)}
                secText={fmtSec(g.n, g.p, g.b)}
                isCount={isCount}
                active={filters.style === g.idx}
                onClick={() => toggleFilter("style", g.idx)}
              />
            ))}
          </div>

          <div className="jrn-tag-cloud-wrap">
            <div className="jrn-fc-head">
              <span className="jrn-fc-title">복기 태그별 성과</span>
              <span className="jrn-fc-meta">누르면 조건 적용</span>
            </div>
            <div className={`jrn-tag-cloud${filters.tag !== null ? " jrn-has-sel" : ""}`}>
              {tagStats.length === 0 ? (
                <span className="jrn-mute">태그 없음</span>
              ) : (
                tagStats.map((x) => (
                  <button
                    key={x.tag}
                    type="button"
                    className="jrn-tag-chip"
                    aria-pressed={filters.tag === x.tag}
                    onClick={() => toggleFilter("tag", x.tag)}
                  >
                    <span className={`jrn-tag-dot${x.p > 0 ? " jrn-bg-up" : x.p < 0 ? " jrn-bg-dn" : ""}`} />
                    <span>{`#${x.tag}`}</span>
                    <em>{`${x.n} · ${formatCompactWon(x.p)}`}</em>
                  </button>
                ))
              )}
            </div>
          </div>
        </div>

        <div>
          <div className="jrn-fc-head">
            <span className="jrn-fc-title">종목별 실현손익</span>
            <span className="jrn-fc-meta">{`${symRows.list.length}개 종목`}</span>
          </div>
          <div className={`jrn-div-list jrn-div-scroll${filters.sym !== null ? " jrn-has-sel" : ""}`}>
            {symRows.list.length === 0 ? (
              <span className="jrn-mute">거래 없음</span>
            ) : (
              symRows.list.map((g) => (
                <DivergingRow
                  key={g.code}
                  label={g.name}
                  sub={`${g.n}건 · 승률 ${g.n > 0 ? Math.round((g.w / g.n) * 100) : 0}%`}
                  val={metricValueOf(g.p, g.b, g.n, metric)}
                  maxAbs={symRows.maxAbs}
                  mainText={fmtMain(g.n, g.p, g.b)}
                  secText={fmtSec(g.n, g.p, g.b)}
                  isCount={isCount}
                  active={filters.sym === g.code}
                  onClick={() => toggleFilter("sym", g.code)}
                />
              ))
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
