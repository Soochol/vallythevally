import { memo, useMemo, useState, type PointerEvent } from "react";
import type { Market } from "../../api/generated/Market";
import type { MarketOverviewPeriod } from "../../api/generated/MarketOverviewPeriod";
import { useMarketFlow, useMarketIntraday } from "../../api/marketOverview";
import { formatKstClock } from "../../chart/time";
import { useOverviewOn } from "../status/marketFeed";
import { CardError, CardShell, EmptyNote, FeedUnavailable, Loaded } from "./CardPart";
import { cumulativeLines, lastValues, linePath, nearestTime, SUBJECT_LABEL, SUBJECTS, spreadLabels, valuesAt, yFraction, zeroY, type CumulativeLines, type Subject } from "./cumulativeLines";
import { investorTotals } from "./investorTotals";
import { signedEok, toneOf } from "./marketFormat";

const FRAME = { width: 320, height: 120 };
const GRID_FRACTIONS = [0, 0.5, 1] as const;
const LABEL_GAP = 0.12;
const BARS_SKELETON = { shape: "line", minHeight: "var(--mk-skeleton-flow-bars)" } as const;
const LINES_SKELETON = { shape: "chart", minHeight: "var(--mk-skeleton-flow-lines)" } as const;

function SubjectBars({ totals }: { totals: Record<Subject, number | null> }) {
  const largest = Math.max(1, ...SUBJECTS.map((subject) => Math.abs(totals[subject] ?? 0)));
  return (
    <ul className="mk-bars" aria-label="주체별 순매수 막대">
      {SUBJECTS.map((subject) => {
        const value = totals[subject];
        return (
          <li key={subject} className="mk-bar-row" data-subject={subject} data-eok={value ?? undefined}>
            <span className="mk-bar-label"><i className="mk-swatch" data-series={subject} aria-hidden="true" />{SUBJECT_LABEL[subject]}</span>
            <span className="mk-bar-track">
              {value !== null && <i data-side={toneOf(value)} style={{ width: `${(Math.abs(value) / largest) * 50}%`, [value < 0 ? "right" : "left"]: "50%" }} />}
            </span>
            <span className="mk-bar-value" data-tone={value === null ? "flat" : toneOf(value)}>{value === null ? "—" : signedEok(value)}</span>
          </li>
        );
      })}
    </ul>
  );
}

const LinesPlot = memo(function LinesPlot({ lines }: { lines: CumulativeLines }) {
  const zero = zeroY(lines, FRAME);
  return (
    <svg className="mk-lines-plot" viewBox={`0 0 ${FRAME.width} ${FRAME.height}`} role="img" aria-label="장중 누적선" preserveAspectRatio="none">
      {GRID_FRACTIONS.map((fraction) => (
        <line key={fraction} className="mk-lines-grid" x1={0} x2={FRAME.width} y1={fraction * FRAME.height} y2={fraction * FRAME.height} vectorEffect="non-scaling-stroke" />
      ))}
      <line className="mk-lines-zero" x1={0} x2={FRAME.width} y1={zero} y2={zero} />
      {SUBJECTS.map((subject) => (
        <path key={subject} className="mk-line" data-subject={subject} d={linePath(lines, subject, FRAME)} vectorEffect="non-scaling-stroke" />
      ))}
    </svg>
  );
});

function LineEnds({ lines }: { lines: CumulativeLines }) {
  const ends = useMemo(() => {
    const last = lastValues(lines);
    const shown = SUBJECTS.filter((subject) => last[subject] !== null);
    const spread = spreadLabels(shown.map((subject) => yFraction(lines, last[subject]!)), LABEL_GAP);
    return shown.map((subject, index) => ({ subject, eok: last[subject]!, top: spread[index]! }));
  }, [lines]);
  return (
    <ul className="mk-lines-ends" aria-label="선 끝 값">
      {ends.map((end) => (
        <li key={end.subject} data-subject={end.subject} style={{ top: `${end.top * 100}%` }}>{SUBJECT_LABEL[end.subject]} {signedEok(end.eok)}</li>
      ))}
    </ul>
  );
}

function LinesPointer({ lines }: { lines: CumulativeLines }) {
  const [at, setAt] = useState<number | null>(null);
  const onMove = (event: PointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const fraction = Math.min(1, Math.max(0, (event.clientX - box.left) / Math.max(box.width, 1)));
    setAt(nearestTime(lines, lines.from + fraction * (lines.to - lines.from)));
  };
  const left = at === null ? 0 : ((at - lines.from) / Math.max(lines.to - lines.from, 1)) * 100;
  const values = at === null ? null : valuesAt(lines, at);
  return (
    <div className="mk-lines-pointer" onPointerMove={onMove} onPointerLeave={() => setAt(null)} data-testid="flow-pointer">
      {at !== null && values !== null && (
        <>
          <span className="mk-lines-cursor" style={{ left: `${left}%` }} />
          <div className="mk-lines-tip" role="tooltip" data-side={left > 55 ? "left" : "right"} style={{ left: `${left}%` }}>
            <strong>{formatKstClock(at)}</strong>
            {SUBJECTS.map((subject) => (
              <span key={subject} data-subject={subject}><i className="mk-swatch" data-series={subject} aria-hidden="true" />{SUBJECT_LABEL[subject]} {values[subject] === null ? "—" : signedEok(values[subject])}</span>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function IntradayLines({ market, enabled }: { market: Market; enabled: boolean }) {
  const on = useOverviewOn("intradayFlow");
  const query = useMarketIntraday(market, { enabled: enabled && on });
  if (!on) return <FeedUnavailable />;
  return (
    <Loaded query={query} label="장중 누적선" skeleton={LINES_SKELETON}>
      {(flow) => {
        const lines = cumulativeLines(flow.points);
        if (lines === null) return <EmptyNote>오늘 쌓인 장중 표본이 없습니다</EmptyNote>;
        const ticks = [lines.max, (lines.max + lines.min) / 2, lines.min];
        const middle = Math.round((lines.from + lines.to) / 2);
        return (
          <div className="mk-lines">
            <ul className="mk-lines-yaxis" aria-hidden="true">
              {ticks.map((eok, index) => <li key={index}>{signedEok(Math.round(eok))}</li>)}
            </ul>
            <div className="mk-lines-body">
              <LinesPlot lines={lines} />
              <LinesPointer lines={lines} />
            </div>
            <LineEnds lines={lines} />
            <ul className="mk-lines-xaxis" aria-hidden="true">
              {[lines.from, middle, lines.to].map((at) => <li key={at}>{formatKstClock(at)}</li>)}
            </ul>
            <ul className="mk-legend" aria-label="누적선 범례">
              {SUBJECTS.map((subject) => (
                <li key={subject} data-subject={subject}><i className="mk-swatch" data-series={subject} aria-hidden="true" />{SUBJECT_LABEL[subject]}</li>
              ))}
            </ul>
          </div>
        );
      }}
    </Loaded>
  );
}

export function FlowCard({ market, period, enabled }: { market: Market; period: MarketOverviewPeriod; enabled: boolean }) {
  const on = useOverviewOn("flow");
  const query = useMarketFlow(market, period, { enabled: enabled && on });
  return (
    <CardShell title="누가 사고 파나" card="flow" note={`최근 ${period}거래일 순매수 · 오늘 누적선`} source={query.data?.context.source}>
      <div className="mk-flow">
        <section className="mk-flow-part" aria-label="주체별 순매수">
          <h3>주체별 순매수 · 최근 {period}거래일</h3>
          {!on ? <FeedUnavailable /> : <Loaded query={query} label="주체별 수급" skeleton={BARS_SKELETON}>
            {(card) => {
              const investors = card.investors.status === "ok" ? card.investors.value : null;
              const program = card.program.status === "ok" ? card.program.value : null;
              const failed = card.investors.status === "failed" ? card.investors.error.message : card.program.status === "failed" ? card.program.error.message : null;
              return (
                <>
                  <SubjectBars totals={investorTotals(investors, program)} />
                  {failed !== null && <CardError message={failed} />}
                </>
              );
            }}
          </Loaded>}
        </section>
        <section className="mk-flow-part mk-flow-lines" aria-label="오늘 누적선">
          <h3>오늘 누적선</h3>
          <IntradayLines market={market} enabled={enabled} />
        </section>
      </div>
    </CardShell>
  );
}
