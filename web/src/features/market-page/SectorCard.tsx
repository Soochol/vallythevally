import { useMemo, useRef, useState } from "react";
import type { Market } from "../../api/generated/Market";
import type { MarketOverviewSector } from "../../api/generated/MarketOverviewSector";
import type { MarketOverviewSectorFlow } from "../../api/generated/MarketOverviewSectorFlow";
import { useMarketSectors, useMarketThemes } from "../../api/marketOverview";
import { legendStops, needsStrongInk, rateFill, rateSide, type ColorRange } from "../../lib/heat/colors";
import { useElementSize } from "../heatmap-page/useElementSize";
import { useOverviewOn } from "../status/marketFeed";
import { Segmented, type SegmentedOption } from "../ui/Segmented";
import { CardError, CardShell, EmptyNote, FeedUnavailable, Loaded, PartView } from "./CardPart";
import { ThemeRotationPanel } from "./ThemeRotationPanel";
import { formatEok, signedEok, signedRate, toneOf } from "./marketFormat";
import { layoutSectorMap, SECTOR_RATE_RANGE, sectorTileLabel } from "./sectorMap";

const MAP_WIDTH = 100;
const MAP_HEIGHT = 56;
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

function SectorMap({ sectors, selected, onSelect }: { sectors: readonly MarketOverviewSector[]; selected: string | null; onSelect: (code: string) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const size = useElementSize(box);
  const tiles = useMemo(() => layoutSectorMap(sectors, MAP_WIDTH, MAP_HEIGHT), [sectors]);
  const byCode = new Map(sectors.map((sector) => [sector.code, sector]));
  return (
    <div className="mk-map" role="group" aria-label="업종 지도" ref={box}>
      {tiles.map((tile) => {
        const sector = byCode.get(tile.code)!;
        const label = sectorTileLabel((tile.w / MAP_WIDTH) * size.w, (tile.h / MAP_HEIGHT) * size.h);
        return (
          <button
            key={tile.code}
            type="button"
            className="mk-tile"
            data-code={sector.code}
            data-side={rateSide(sector.changeRate)}
            data-label={label}
            data-strong={needsStrongInk(sector.changeRate, RANGE)}
            aria-pressed={selected === sector.code}
            aria-label={`${sector.name} ${signedRate(sector.changeRate)} 거래대금 ${formatEok(sector.tradeValueEok)}`}
            style={{ left: `${(tile.x / MAP_WIDTH) * 100}%`, top: `${(tile.y / MAP_HEIGHT) * 100}%`, width: `${(tile.w / MAP_WIDTH) * 100}%`, height: `${(tile.h / MAP_HEIGHT) * 100}%`, background: rateFill(sector.changeRate, RANGE) }}
            onClick={() => onSelect(sector.code)}
          >
            {label === "full" && <span className="mk-tile-name">{sector.name}</span>}
            {label !== "none" && <span className="mk-tile-rate">{signedRate(sector.changeRate)}</span>}
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
      <h3>{sector.name} 주체별 수급</h3>
      {flow === null ? (
        <EmptyNote>이 업종의 수급 자료가 없습니다</EmptyNote>
      ) : (
        <dl>
          {rows.map(([label, key]) => {
            const value = Number(flow[key]);
            return (
              <div key={key} data-subject={key}>
                <dt>{label}</dt>
                <dd data-tone={toneOf(value)}>{signedEok(value)}</dd>
                {whole !== null && <dd className="mk-sector-whole">시장 {signedEok(Number(whole[key]))}</dd>}
              </div>
            );
          })}
        </dl>
      )}
    </div>
  );
}

export function SectorCard({ market, enabled }: { market: Market; enabled: boolean }) {
  const on = useOverviewOn("sectors");
  const [mode, setMode] = useState<SectorCardMode>("sectors");
  const query = useMarketSectors(market, { enabled: enabled && on });
  const themesQuery = useMarketThemes({ enabled: enabled && mode === "themes" });
  const [picked, setPicked] = useState<string | null>(null);
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
      source={mode === "themes" ? themesQuery.data?.source : query.data?.context.source}
    >
      {mode === "themes" ? (
        <ThemeRotationPanel enabled={enabled && mode === "themes"} />
      ) : !on ? (
        <FeedUnavailable />
      ) : (
        <Loaded query={query} label="업종 지도" skeleton={SECTOR_SKELETON}>
          {(card) => (
            <PartView part={card.sectors}>
              {(sectors) => {
                const selected = sectors.find((sector) => sector.code === picked) ?? null;
                const flows = card.flows.status === "ok" ? card.flows.value : null;
                return (
                  <>
                    <SectorMap sectors={sectors} selected={selected?.code ?? null} onSelect={(code) => setPicked((current) => (current === code ? null : code))} />
                    <div className="mk-sector-detail">
                      {selected === null ? (
                        <p className="mk-hint">업종 칸을 누르면 그 업종의 주체별 수급을 보입니다. 고른 칸을 다시 누르면 풀립니다</p>
                      ) : flows === null ? (
                        <CardError message={card.flows.status === "failed" ? card.flows.error.message : "수급을 받지 못했습니다"} />
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
