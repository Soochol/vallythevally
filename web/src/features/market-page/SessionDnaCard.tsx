import type { MarketOverviewScope } from "../../api/generated/MarketOverviewScope";
import type { MarketOverviewSessionDna } from "../../api/generated/MarketOverviewSessionDna";
import { useMarketPro } from "../../api/marketOverview";
import { CardShell, EmptyNote, Loaded, PartView } from "./CardPart";
import { formatPercent, scopeLabel } from "./derivedFormat";
import { formatCount, formatEok, signedEok, toneOf } from "./marketFormat";
import { SESSION_SUBJECTS, sessionBarPercent, sessionMaxAbsEok, venueSplitOf } from "./proFormat";

const PRO_SKELETON = { shape: "chart", minHeight: "var(--mk-skeleton-pro)" } as const;

function SessionDnaBody({ dna }: { dna: MarketOverviewSessionDna }) {
  const maxAbs = sessionMaxAbsEok(dna.windows);
  const split = venueSplitOf(dna.krxTradeValueEok, dna.nxtTradeValueEok);

  return (
    <div className="mk-dna-wrap">
      <div className="mk-dna-venue" data-testid="session-venue-split">
        <div className="mk-dna-venue-head">
          <span>거래소 거래대금 비중</span>
          <span className="mk-num">합산 {formatEok(split.totalEok)}</span>
        </div>
        <div
          className="mk-venue-bar"
          role="img"
          aria-label={`KRX ${formatPercent(split.krxPct)} · NXT ${formatPercent(split.nxtPct)}`}
        >
          <i data-venue="krx" style={{ width: `${split.krxPct}%` }} />
          <i data-venue="nxt" style={{ width: `${split.nxtPct}%` }} />
        </div>
        <div className="mk-dna-venue-legend">
          <span data-venue="krx">
            <i className="mk-venue-dot" data-venue="krx" aria-hidden="true" />
            KRX <strong className="mk-num">{formatPercent(split.krxPct)}</strong> ({formatEok(dna.krxTradeValueEok)})
          </span>
          <span data-venue="nxt">
            <i className="mk-venue-dot" data-venue="nxt" aria-hidden="true" />
            NXT <strong className="mk-num">{formatPercent(split.nxtPct)}</strong> ({formatEok(dna.nxtTradeValueEok)})
          </span>
        </div>
      </div>

      {dna.windows.length === 0 ? (
        <EmptyNote>세션 구간 표본이 없습니다</EmptyNote>
      ) : (
        <ol className="mk-dna-grid" aria-label="장중 6구간 수급 타임라인">
          {dna.windows.map((window) => {
            const active = dna.activeWindow === window.id;
            return (
              <li
                key={window.id}
                className="mk-dna-window"
                data-window={window.id}
                data-active={active ? "true" : "false"}
              >
                <div className="mk-dna-win-head">
                  <div className="mk-dna-win-title">
                    <strong>{window.label}</strong>
                    {active && <span className="mk-dna-live">진행 중</span>}
                  </div>
                  <span className="mk-dna-win-time mk-num">{window.timeRange}</span>
                </div>
                <ul className="mk-dna-bars" aria-label={`${window.label} 주체별 증감`}>
                  {SESSION_SUBJECTS.map((subject) => {
                    const value = window[subject.key];
                    const tone = toneOf(value);
                    const widthPct = sessionBarPercent(value, maxAbs);
                    return (
                      <li key={subject.id} className="mk-dna-bar-row" data-subject={subject.id}>
                        <span className="mk-dna-subj">{subject.label}</span>
                        <span className="mk-dna-track">
                          {widthPct > 0 && (
                            <i
                              data-side={tone}
                              style={
                                value >= 0
                                  ? { left: "50%", width: `${widthPct / 2}%` }
                                  : { right: "50%", width: `${widthPct / 2}%` }
                              }
                            />
                          )}
                        </span>
                        <span className="mk-dna-val mk-num" data-tone={tone}>
                          {signedEok(value)}
                        </span>
                      </li>
                    );
                  })}
                </ul>
                <span className="mk-dna-samples mk-num">표본 {formatCount(window.sampleCount)}건</span>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

export function SessionDnaCard({ scope, enabled }: { scope: MarketOverviewScope; enabled: boolean }) {
  const query = useMarketPro(scope, { enabled });
  const day = query.data?.sessionDna.status === "ok" ? query.data.sessionDna.value.day : null;

  return (
    <CardShell
      title="장중 세션 DNA"
      card="session-dna"
      note={day === null ? `${scopeLabel(scope)} 기준 · 08:00–20:00 KST` : `${scopeLabel(scope)} · ${day} · 08:00–20:00 KST`}
    >
      <Loaded query={query} label="장중 세션 DNA" skeleton={PRO_SKELETON}>
        {(card) => (
          <PartView part={card.sessionDna}>
            {(dna) => <SessionDnaBody dna={dna} />}
          </PartView>
        )}
      </Loaded>
    </CardShell>
  );
}
