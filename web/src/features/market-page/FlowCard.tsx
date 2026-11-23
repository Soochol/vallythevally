import type { Market } from "../../api/generated/Market";
import type { MarketOverviewPeriod } from "../../api/generated/MarketOverviewPeriod";
import { useMarketFlow, useMarketIntraday } from "../../api/marketOverview";
import { useOverviewOn } from "../status/marketFeed";
import { CardError, CardShell, FeedUnavailable, Loaded } from "./CardPart";
import { cumulativeLines, linePath, SUBJECT_LABEL, SUBJECTS, zeroY, type Subject } from "./cumulativeLines";
import { investorTotals } from "./investorTotals";
import { signedEok, toneOf } from "./marketFormat";

const FRAME = { width: 320, height: 120 };

function SubjectBars({ totals }: { totals: Record<Subject, number | null> }) {
  const largest = Math.max(1, ...SUBJECTS.map((subject) => Math.abs(totals[subject] ?? 0)));
  return (
    <ul className="mk-bars" aria-label="주체별 순매수 막대">
      {SUBJECTS.map((subject) => {
        const value = totals[subject];
        return (
          <li key={subject} className="mk-bar-row" data-subject={subject} data-eok={value ?? undefined}>
            <span className="mk-bar-label">{SUBJECT_LABEL[subject]}</span>
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

function IntradayLines({ market, enabled }: { market: Market; enabled: boolean }) {
  const on = useOverviewOn("intradayFlow");
  const query = useMarketIntraday(market, { enabled: enabled && on });
  if (!on) return <FeedUnavailable />;
  return (
    <Loaded query={query} label="장중 누적선">
      {(flow) => {
        const lines = cumulativeLines(flow.points);
        if (lines === null) return <p className="mk-empty">오늘 쌓인 장중 표본이 없습니다</p>;
        return (
          <div className="mk-lines">
            <svg className="mk-lines-plot" viewBox={`0 0 ${FRAME.width} ${FRAME.height}`} role="img" aria-label="장중 누적선" preserveAspectRatio="none">
              <line className="mk-lines-zero" x1={0} x2={FRAME.width} y1={zeroY(lines, FRAME)} y2={zeroY(lines, FRAME)} />
              {SUBJECTS.map((subject) => (
                <path key={subject} className="mk-line" data-subject={subject} d={linePath(lines, subject, FRAME)} vectorEffect="non-scaling-stroke" />
              ))}
            </svg>
            <ul className="mk-legend" aria-label="누적선 범례">
              {SUBJECTS.map((subject) => (
                <li key={subject} data-subject={subject}>{SUBJECT_LABEL[subject]}</li>
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
    <CardShell title="누가 사고 파나" note={`최근 ${period}거래일 순매수 · 오늘 누적선`} source={query.data?.context.source}>
      <div className="mk-flow">
        <div className="mk-flow-bars">
          {!on ? <FeedUnavailable /> : <Loaded query={query} label="주체별 수급">
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
        </div>
        <IntradayLines market={market} enabled={enabled} />
      </div>
    </CardShell>
  );
}
