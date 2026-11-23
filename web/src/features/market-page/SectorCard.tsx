import { useMemo, useState } from "react";
import type { Market } from "../../api/generated/Market";
import type { MarketOverviewSector } from "../../api/generated/MarketOverviewSector";
import type { MarketOverviewSectorFlow } from "../../api/generated/MarketOverviewSectorFlow";
import { useMarketSectors } from "../../api/marketOverview";
import { useOverviewOn } from "../status/marketFeed";
import { CardError, CardShell, FeedUnavailable, Loaded, PartView } from "./CardPart";
import { formatEok, signedEok, signedRate, toneOf } from "./marketFormat";
import { layoutSectorMap, sectorFill } from "./sectorMap";

const MAP_WIDTH = 100;
const MAP_HEIGHT = 56;

function SectorMap({ sectors, selected, onSelect }: { sectors: readonly MarketOverviewSector[]; selected: string | null; onSelect: (code: string) => void }) {
  const tiles = useMemo(() => layoutSectorMap(sectors, MAP_WIDTH, MAP_HEIGHT), [sectors]);
  const byCode = new Map(sectors.map((sector) => [sector.code, sector]));
  return (
    <div className="mk-map" role="group" aria-label="업종 지도">
      {tiles.map((tile) => {
        const sector = byCode.get(tile.code)!;
        return (
          <button
            key={tile.code}
            type="button"
            className="mk-tile"
            data-code={sector.code}
            data-side={toneOf(sector.changeRate)}
            aria-pressed={selected === sector.code}
            aria-label={`${sector.name} ${signedRate(sector.changeRate)} 거래대금 ${formatEok(sector.tradeValueEok)}`}
            style={{ left: `${(tile.x / MAP_WIDTH) * 100}%`, top: `${(tile.y / MAP_HEIGHT) * 100}%`, width: `${(tile.w / MAP_WIDTH) * 100}%`, height: `${(tile.h / MAP_HEIGHT) * 100}%`, background: sectorFill(sector.changeRate) }}
            onClick={() => onSelect(sector.code)}
          >
            <span className="mk-tile-name">{sector.name}</span>
            <span className="mk-tile-rate">{signedRate(sector.changeRate)}</span>
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
        <p className="mk-empty">이 업종의 수급 자료가 없습니다</p>
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
  const query = useMarketSectors(market, { enabled: enabled && on });
  const [picked, setPicked] = useState<string | null>(null);
  return (
    <CardShell title="업종 지도" note="칸 크기 거래대금 · 색 등락률" source={query.data?.context.source}>
      {!on ? <FeedUnavailable /> : <Loaded query={query} label="업종 지도">
        {(card) => (
          <PartView part={card.sectors}>
            {(sectors) => {
              const selected = sectors.find((sector) => sector.code === picked) ?? null;
              const flows = card.flows.status === "ok" ? card.flows.value : null;
              return (
                <>
                  <SectorMap sectors={sectors} selected={selected?.code ?? null} onSelect={setPicked} />
                  {selected === null ? (
                    <p className="mk-hint">업종 칸을 누르면 그 업종의 주체별 수급을 보입니다</p>
                  ) : flows === null ? (
                    <CardError message={card.flows.status === "failed" ? card.flows.error.message : "수급을 받지 못했습니다"} />
                  ) : (
                    <SectorFlowDetail sector={selected} flow={flows.find((row) => row.code === selected.code) ?? null} whole={flows.find((row) => row.wholeMarket) ?? null} />
                  )}
                </>
              );
            }}
          </PartView>
        )}
      </Loaded>}
    </CardShell>
  );
}
