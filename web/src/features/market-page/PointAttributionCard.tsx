import type { MarketOverviewAttributionRow } from "../../api/generated/MarketOverviewAttributionRow";
import type { MarketOverviewScope } from "../../api/generated/MarketOverviewScope";
import { useMarketDerived } from "../../api/marketOverview";
import { useSendSymbol } from "../pages/sendSymbol";
import { CardShell, EmptyNote, Loaded, PartView } from "./CardPart";
import { attributionBarPercent, formatPercent, MARKET_LABEL } from "./derivedFormat";
import { signedPoints, signedRate, toneOf } from "./marketFormat";

const ATTRIBUTION_SKELETON = { shape: "card", minHeight: "var(--mk-skeleton-derived)" } as const;

function AttributionGroup({
  title,
  side,
  rows,
  maxAbs,
}: {
  title: string;
  side: "up" | "down";
  rows: readonly MarketOverviewAttributionRow[];
  maxAbs: number;
}) {
  const send = useSendSymbol();
  return (
    <section className="mk-attr-group" aria-label={title}>
      <h3>{title}</h3>
      {rows.length === 0 ? (
        <EmptyNote>해당 기여 종목이 없습니다</EmptyNote>
      ) : (
        <ul className="mk-attr-list">
          {rows.map((row) => (
            <li key={row.code} className="mk-attr-item" data-code={row.code}>
              <button type="button" className="mk-attr-row" onClick={() => send({ code: row.code, name: row.name })}>
                <span className="mk-attr-name">
                  <span>{row.name}</span>
                  <span className="mk-stock-code">{row.code}</span>
                </span>
                <span className="mk-attr-track">
                  <i data-side={side} style={{ width: `${attributionBarPercent(row.points, maxAbs)}%` }} />
                </span>
                <span className="mk-attr-pts" data-tone={toneOf(row.points)}>{signedPoints(row.points)}pt</span>
                <span className="mk-attr-rate" data-tone={toneOf(row.changeRate)}>{signedRate(row.changeRate)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function PointAttributionCard({ scope, enabled }: { scope: MarketOverviewScope; enabled: boolean }) {
  const query = useMarketDerived(scope, { enabled });
  const attribution = query.data?.attribution.status === "ok" ? query.data.attribution.value : null;
  const note = attribution === null ? "지수 등락 기여 종목" : `${MARKET_LABEL[attribution.market]} 기준 · 지수 변동 ${signedPoints(attribution.indexChangePoints)}pt`;

  return (
    <CardShell
      title="지수 기여도"
      card="attribution"
      note={
        <>
          <span>{note}</span>
          {attribution !== null && (
            <span className="mk-pill-badge" data-testid="attribution-concentration">
              상위 2종목 집중도 {formatPercent(attribution.topTwoConcentrationPct)}
            </span>
          )}
        </>
      }
    >
      <Loaded query={query} label="지수 기여도" skeleton={ATTRIBUTION_SKELETON}>
        {(card) => (
          <PartView part={card.attribution}>
            {(value) => {
              const allRows = [...value.topPositive, ...value.topNegative];
              const maxAbs = Math.max(0.01, ...allRows.map((row) => Math.abs(row.points)));
              return (
                <div className="mk-attr-grid">
                  <AttributionGroup title="상승 기여 상위" side="up" rows={value.topPositive} maxAbs={maxAbs} />
                  <AttributionGroup title="하락 기여 상위" side="down" rows={value.topNegative} maxAbs={maxAbs} />
                </div>
              );
            }}
          </PartView>
        )}
      </Loaded>
    </CardShell>
  );
}
