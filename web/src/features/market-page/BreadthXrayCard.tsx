import { useState } from "react";
import type { MarketOverviewHistogramBucket } from "../../api/generated/MarketOverviewHistogramBucket";
import type { MarketOverviewScope } from "../../api/generated/MarketOverviewScope";
import type { MarketOverviewVenueShare } from "../../api/generated/MarketOverviewVenueShare";
import { useMarketDerived } from "../../api/marketOverview";
import { CardShell, EmptyNote, Loaded, PartView } from "./CardPart";
import { bucketTone, formatPercent, scopeLabel } from "./derivedFormat";
import { formatCount, formatEok } from "./marketFormat";

const XRAY_SKELETON = { shape: "chart", minHeight: "var(--mk-skeleton-xray)" } as const;

function HistogramPlot({ buckets }: { buckets: readonly MarketOverviewHistogramBucket[] }) {
  const [picked, setPicked] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  if (buckets.length === 0) return <EmptyNote>등락률 분포 표본이 없습니다</EmptyNote>;
  const maxCount = Math.max(1, ...buckets.map((bucket) => bucket.count));
  const totalCount = buckets.reduce((sum, bucket) => sum + bucket.count, 0);
  const active = buckets.find((bucket) => bucket.label === (picked ?? hovered)) ?? null;

  return (
    <div className="mk-hist-wrap">
      <div className="mk-hist-meta">
        <span>전체 {formatCount(totalCount)}종목</span>
        <span className="mk-hist-selected" data-testid="histogram-readout">
          {active === null ? "막대를 눌러 구간별 비중을 확인하세요" : `${active.label} · ${formatCount(active.count)}종목 (${formatPercent(active.sharePct)})`}
        </span>
      </div>
      <ol className="mk-hist-bars" aria-label="등락률 9구간 막대">
        {buckets.map((bucket) => {
          const tone = bucketTone(bucket.label);
          const heightPct = Math.max(bucket.count > 0 ? 6 : 0, (bucket.count / maxCount) * 100);
          const selected = picked === bucket.label;
          return (
            <li key={bucket.label} className="mk-hist-col" data-bucket={bucket.label} data-tone={tone}>
              <button
                type="button"
                className="mk-hist-btn"
                aria-pressed={selected}
                aria-label={`${bucket.label} ${formatCount(bucket.count)}종목 ${formatPercent(bucket.sharePct)}`}
                onClick={() => setPicked((current) => (current === bucket.label ? null : bucket.label))}
                onMouseEnter={() => setHovered(bucket.label)}
                onMouseLeave={() => setHovered((current) => (current === bucket.label ? null : current))}
              >
                <span className="mk-hist-count">{formatCount(bucket.count)}</span>
                <span className="mk-hist-track">
                  <i data-tone={tone} style={{ height: `${heightPct}%` }} />
                </span>
                <span className="mk-hist-label">{bucket.label}</span>
                <span className="mk-hist-share">{formatPercent(bucket.sharePct)}</span>
              </button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function VenueShareView({ share }: { share: MarketOverviewVenueShare }) {
  const total = share.krxTradeValueEok + share.nxtTradeValueEok;
  return (
    <div className="mk-venue-wrap">
      <div className="mk-venue-bar" role="img" aria-label={`KRX ${formatPercent(share.krxRatioPct)} · NXT ${formatPercent(share.nxtRatioPct)}`}>
        <i data-venue="krx" style={{ width: `${share.krxRatioPct}%` }} />
        <i data-venue="nxt" style={{ width: `${share.nxtRatioPct}%` }} />
      </div>
      <dl className="mk-venue-stats">
        <div className="mk-venue-cell" data-venue="krx">
          <dt><i className="mk-venue-dot" data-venue="krx" aria-hidden="true" />KRX 정규장</dt>
          <dd className="mk-venue-pct">{formatPercent(share.krxRatioPct)}</dd>
          <dd className="mk-venue-amt">{formatEok(share.krxTradeValueEok)}</dd>
        </div>
        <div className="mk-venue-cell" data-venue="nxt">
          <dt><i className="mk-venue-dot" data-venue="nxt" aria-hidden="true" />NXT 대체거래소</dt>
          <dd className="mk-venue-pct">{formatPercent(share.nxtRatioPct)}</dd>
          <dd className="mk-venue-amt">{formatEok(share.nxtTradeValueEok)}</dd>
        </div>
      </dl>
      <p className="mk-venue-total">합산 거래대금 {formatEok(total)}</p>
    </div>
  );
}

export function BreadthXrayCard({ scope, enabled }: { scope: MarketOverviewScope; enabled: boolean }) {
  const query = useMarketDerived(scope, { enabled });
  return (
    <CardShell title="시장 체력 X-Ray" card="xray" note={`${scopeLabel(scope)} 기준 · 9구간 등락률 분포 · 거래소 비중`}>
      <Loaded query={query} label="시장 체력 X-Ray" skeleton={XRAY_SKELETON}>
        {(card) => (
          <div className="mk-xray-grid">
            <section className="mk-xray-part" aria-label="등락률 9구간 분포">
              <h3>등락률 9구간 분포</h3>
              <PartView part={card.histogram} onRetry={() => void query.refetch()}>{(buckets) => <HistogramPlot buckets={buckets} />}</PartView>
            </section>
            <section className="mk-xray-part mk-xray-venue" aria-label="거래소 거래대금 비중">
              <h3>거래소 거래대금 비중 (KRX · NXT)</h3>
              <PartView part={card.venueShare} onRetry={() => void query.refetch()}>{(share) => <VenueShareView share={share} />}</PartView>
            </section>
          </div>
        )}
      </Loaded>
    </CardShell>
  );
}
