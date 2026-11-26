import { useState } from "react";
import type { MarketOverviewDisclosureRadar } from "../../api/generated/MarketOverviewDisclosureRadar";
import type { MarketOverviewScope } from "../../api/generated/MarketOverviewScope";
import { useMarketPro } from "../../api/marketOverview";
import { useSendSymbol } from "../pages/sendSymbol";
import { CardShell, EmptyNote, Loaded, PartView } from "./CardPart";
import { MARKET_LABEL, scopeLabel } from "./derivedFormat";
import { formatCount, signedRate, toneOf } from "./marketFormat";
import {
  DISCLOSURE_FILTERS,
  disclosureCategoryLabel,
  disclosureCountFor,
  filterDisclosures,
  formatReceiptDate,
  type DisclosureFilter,
} from "./proFormat";

const PRO_SKELETON = { shape: "card", minHeight: "var(--mk-skeleton-pro)" } as const;

function DisclosureRadarBody({ radar }: { radar: MarketOverviewDisclosureRadar }) {
  const [filter, setFilter] = useState<DisclosureFilter>("all");
  const send = useSendSymbol();
  const visible = filterDisclosures(radar.items, filter);

  return (
    <div className="mk-disc-wrap">
      <div className="mk-disc-chips" role="group" aria-label="공시 유형 필터">
        {DISCLOSURE_FILTERS.map((entry) => {
          const count = disclosureCountFor(radar.items, entry.id);
          return (
            <button
              key={entry.id}
              type="button"
              className="mk-disc-chip"
              data-category={entry.id}
              aria-pressed={filter === entry.id}
              onClick={() => setFilter(entry.id)}
            >
              <span>{entry.label}</span>
              <span className="mk-disc-chip-count mk-num">{formatCount(count)}</span>
            </button>
          );
        })}
      </div>

      {visible.length === 0 ? (
        <EmptyNote>해당 유형의 핵심 공시가 없습니다</EmptyNote>
      ) : (
        <ul className="mk-disc-list" aria-label="핵심 공시 목록">
          {visible.map((item) => (
            <li
              key={`${item.code}-${item.receiptNo || item.reportName}`}
              className="mk-disc-item"
              data-code={item.code}
              data-category={item.category}
            >
              <button
                type="button"
                className="mk-disc-row"
                onClick={() => send({ code: item.code, name: item.name })}
              >
                <span className="mk-disc-date mk-num">{formatReceiptDate(item.receiptDate)}</span>
                <span className="mk-disc-badge" data-category={item.category}>
                  {disclosureCategoryLabel(item.category)}
                </span>
                <span className="mk-disc-main">
                  <span className="mk-disc-stock">
                    <strong>{item.name}</strong>
                    <span className="mk-stock-code">{item.code}</span>
                    {item.market !== null && <span className="mk-vi-market">{MARKET_LABEL[item.market]}</span>}
                  </span>
                  <span className="mk-disc-report">{item.reportName}</span>
                </span>
                <span className="mk-disc-rate mk-num" data-tone={item.changeRate === null ? "flat" : toneOf(item.changeRate)}>
                  {item.changeRate === null ? "—" : signedRate(item.changeRate)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function DisclosureRadarCard({ scope, enabled }: { scope: MarketOverviewScope; enabled: boolean }) {
  const query = useMarketPro(scope, { enabled });
  const radar = query.data?.disclosures.status === "ok" ? query.data.disclosures.value : null;

  return (
    <CardShell
      title="핵심 공시 레이더"
      card="disclosures"
      note={
        <>
          <span>{scopeLabel(scope)} 기준 · OpenDART 핵심 공시</span>
          {radar !== null && (
            <span className="mk-pill-badge" data-testid="disclosure-total">
              {radar.totalMatched > radar.items.length
                ? `총 ${formatCount(radar.totalMatched)}건 중 최근 ${formatCount(radar.items.length)}건`
                : `총 ${formatCount(radar.totalMatched)}건`}
            </span>
          )}
        </>
      }
    >
      <Loaded query={query} label="핵심 공시 레이더" skeleton={PRO_SKELETON}>
        {(card) => (
          <PartView part={card.disclosures} onRetry={() => void query.refetch()}>
            {(radar) => <DisclosureRadarBody radar={radar} />}
          </PartView>
        )}
      </Loaded>
    </CardShell>
  );
}
