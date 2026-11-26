import { useMemo, useRef, useState } from "react";
import type { Market } from "../../api/generated/Market";
import type { MarketOverviewSector } from "../../api/generated/MarketOverviewSector";
import type { MarketOverviewSectorFlow } from "../../api/generated/MarketOverviewSectorFlow";
import { useMarketSectors, useMarketThemes } from "../../api/marketOverview";
import { legendStops, needsStrongInk, rateFill, rateSide, type ColorRange } from "../../lib/heat/colors";
import { useMarketSource } from "../../stores/kiwoomLink";
import { useElementSize } from "../heatmap-page/useElementSize";
import { feedBrokerOf, useOverviewOn } from "../status/marketFeed";
import { Segmented, type SegmentedOption } from "../ui/Segmented";
import { CardError, CardShell, EmptyNote, FeedUnavailable, Loaded, PartView } from "./CardPart";
import { ThemeRotationPanel } from "./ThemeRotationPanel";
import { formatEok, signedEok, signedRate, toneOf } from "./marketFormat";
import { layoutSectorMap, SECTOR_RATE_RANGE, sectorTileLabel, sectorTileTier } from "./sectorMap";

const MAP_WIDTH = 100;
const MAP_HEIGHT = 44;
const RANGE = SECTOR_RATE_RANGE satisfies ColorRange;
const SECTOR_SKELETON = { shape: "chart", minHeight: "var(--mk-skeleton-sector)" } as const;

type SectorCardMode = "sectors" | "themes";

const SECTOR_MODES: readonly SegmentedOption<SectorCardMode>[] = [
  { value: "sectors", label: "업종 지도" },
  { value: "themes", label: "장중 키움 테마" },
];

function SectorLegend() {
  return (
    <span className="mk-sector-legend" role="img" aria-label={`색 범례 하락 ${signedRate(-RANGE)}에서 상승 ${signedRate(RANGE)}`}>
      <span aria-hidden="true">{signedRate(-RANGE)}</span>
      {legendStops(RANGE).map((stop) => <i key={stop.rate} style={{ background: stop.fill }} aria-hidden="true" />)}
      <span aria-hidden="true">{signedRate(RANGE)}</span>
    </span>
  );
}

function SectorMap({
  sectors,
  selected,
  onHover,
  onSelect,
}: {
  sectors: readonly MarketOverviewSector[];
  selected: string | null;
  onHover: (code: string | null) => void;
  onSelect: (code: string) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const size = useElementSize(box);
  const mapW = size.w > 0 ? size.w : MAP_WIDTH;
  const mapH = size.h > 0 ? size.h : MAP_HEIGHT;
  const tiles = useMemo(() => layoutSectorMap(sectors, mapW, mapH), [sectors, mapW, mapH]);
  const byCode = new Map(sectors.map((sector) => [sector.code, sector]));
  return (
    <div className="mk-map" role="group" aria-label="업종 지도" ref={box}>
      {tiles.map((tile) => {
        const sector = byCode.get(tile.code)!;
        const widthPx = (tile.w / mapW) * size.w;
        const heightPx = (tile.h / mapH) * size.h;
        const label = sectorTileLabel(widthPx, heightPx);
        const tier = sectorTileTier(widthPx, heightPx);
        const showValue = tier === "xl" || tier === "lg";
        return (
          <button
            key={tile.code}
            type="button"
            className="mk-tile"
            data-code={sector.code}
            data-side={rateSide(sector.changeRate)}
            data-label={label}
            data-tier={tier}
            data-strong={needsStrongInk(sector.changeRate, RANGE)}
            aria-pressed={selected === sector.code}
            aria-label={`${sector.name} ${signedRate(sector.changeRate)} 거래대금 ${formatEok(sector.tradeValueEok)}`}
            style={{ left: `${(tile.x / mapW) * 100}%`, top: `${(tile.y / mapH) * 100}%`, width: `${(tile.w / mapW) * 100}%`, height: `${(tile.h / mapH) * 100}%`, background: rateFill(sector.changeRate, RANGE) }}
            onMouseEnter={() => onHover(sector.code)}
            onMouseLeave={() => onHover(null)}
            onFocus={() => onHover(sector.code)}
            onBlur={() => onHover(null)}
            onClick={() => onSelect(sector.code)}
          >
            {label === "full" && <span className="mk-tile-name">{sector.name}</span>}
            {label !== "none" && <span className="mk-tile-rate mk-num">{signedRate(sector.changeRate)}</span>}
            {showValue && <span className="mk-tile-val mk-num">{formatEok(sector.tradeValueEok)}</span>}
          </button>
        );
      })}
    </div>
  );
}

function SectorFlowDetail({ sector, flow, whole }: { sector: MarketOverviewSector; flow: MarketOverviewSectorFlow | null; whole: MarketOverviewSectorFlow | null }) {
  const rows = [
    ["개인", "individualEok"],
    ["외국인", "foreignEok"],
    ["기관", "institutionEok"],
  ] as const;
  return (
    <div className="mk-sector-flow" role="region" aria-label={`${sector.name} 주체별 수급`}>
      <div className="mk-sector-flow-head">
        <h3>{sector.name} 주체별 수급</h3>
        <span className="mk-num" data-tone={toneOf(sector.changeRate)}>{signedRate(sector.changeRate)}</span>
        <span className="mk-sector-flow-val mk-num">거래대금 {formatEok(sector.tradeValueEok)}</span>
      </div>
      {flow === null ? (
        <EmptyNote>이 업종의 수급 자료가 없습니다</EmptyNote>
      ) : (
        <dl>
          {rows.map(([label, key]) => {
            const value = Number(flow[key]);
            return (
              <div key={key} data-subject={key}>
                <dt>{label}</dt>
                <dd className="mk-num" data-tone={toneOf(value)}>{signedEok(value)}</dd>
                {whole !== null && <dd className="mk-sector-whole mk-num">시장 {signedEok(Number(whole[key]))}</dd>}
              </div>
            );
          })}
        </dl>
      )}
    </div>
  );
}

function SectorPreviewBar({ sector }: { sector: MarketOverviewSector }) {
  return (
    <div className="mk-sector-preview">
      <strong>{sector.name}</strong>
      <span className="mk-num" data-tone={toneOf(sector.changeRate)}>{signedRate(sector.changeRate)}</span>
      <span className="mk-sector-flow-val mk-num">거래대금 {formatEok(sector.tradeValueEok)}</span>
      <span className="mk-hint">누르면 이 업종의 주체별 수급을 고정해 보입니다</span>
    </div>
  );
}

export function SectorCard({ market, enabled }: { market: Market; enabled: boolean }) {
  const on = useOverviewOn("sectors");
  const streaksOn = useOverviewOn("streaks");
  const marketSource = useMarketSource();
  const themesOn = streaksOn && feedBrokerOf(marketSource) !== "kis";
  const [mode, setMode] = useState<SectorCardMode>("sectors");
  const query = useMarketSectors(market, { enabled: enabled && on });
  const themesQuery = useMarketThemes({ enabled: enabled && mode === "themes" && themesOn });
  const [picked, setPicked] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  return (
    <CardShell
      title="업종 지도"
      card="sector"
      note={
        <>
          <Segmented label="업종 보기" mode="pressed" size="sm" value={mode} options={SECTOR_MODES} onChange={(next) => setMode(next)} />
          {mode === "sectors" && (
            <>
              <span>칸 크기 거래대금 · 색 등락률</span>
              <SectorLegend />
            </>
          )}
        </>
      }
      source={mode === "themes" ? (themesOn ? themesQuery.data?.source : undefined) : query.data?.context.source}
    >
      {mode === "themes" ? (
        themesOn ? <ThemeRotationPanel enabled={enabled && mode === "themes"} /> : <FeedUnavailable />
      ) : !on ? (
        <FeedUnavailable />
      ) : (
        <Loaded query={query} label="업종 지도" skeleton={SECTOR_SKELETON}>
          {(card) => (
            <PartView part={card.sectors} onRetry={() => void query.refetch()}>
              {(sectors) => {
                const selected = sectors.find((sector) => sector.code === picked) ?? null;
                const preview = selected === null ? sectors.find((sector) => sector.code === hovered) ?? null : null;
                const flows = card.flows.status === "ok" ? card.flows.value : null;
                return (
                  <>
                    <SectorMap
                      sectors={sectors}
                      selected={selected?.code ?? null}
                      onHover={setHovered}
                      onSelect={(code) => setPicked((current) => (current === code ? null : code))}
                    />
                    <div className="mk-sector-detail" data-active={selected !== null ? "true" : "false"}>
                      {selected === null ? (
                        preview !== null ? (
                          <SectorPreviewBar sector={preview} />
                        ) : (
                          <p className="mk-hint">업종 칸에 올리면 요약이 보이고, 누르면 주체별 수급을 보입니다. 고른 칸을 다시 누르면 풀립니다</p>
                        )
                      ) : flows === null ? (
                        <CardError
                          message={card.flows.status === "failed" ? card.flows.error.message : "수급을 받지 못했습니다"}
                          code={card.flows.status === "failed" ? card.flows.error.code : undefined}
                          retry={() => void query.refetch()}
                        />
                      ) : (
                        <SectorFlowDetail sector={selected} flow={flows.find((row) => row.code === selected.code) ?? null} whole={flows.find((row) => row.wholeMarket) ?? null} />
                      )}
                    </div>
                  </>
                );
              }}
            </PartView>
          )}
        </Loaded>
      )}
    </CardShell>
  );
}
