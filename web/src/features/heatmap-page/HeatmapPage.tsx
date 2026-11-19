import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useReducer } from "react";
import { useSearchParams } from "react-router";
import type { Quote } from "../../api/generated/Quote";
import type { SymbolCode } from "../../api/generated/SymbolCode";
import type { Watchlist } from "../../api/generated/Watchlist";
import type { WatchGroup } from "../../api/generated/WatchGroup";
import { useSymbolInfos } from "../../api/queries";
import { fetchQuotes } from "../../api/userData";
import { formatKstClockSeconds } from "../../chart/time";
import { quoteBook } from "../../stores/realtime";
import { useVenue } from "../../stores/ui";
import { useWatchlistStore } from "../../stores/watchlist";
import { EmptyState } from "../overlay/State";
import { PageFrame } from "../pages/PageFrame";
import { HeatmapFlow } from "./HeatmapFlow";
import { HeatmapGroup } from "./HeatmapGroup";
import { HeatmapToolbar } from "./HeatmapToolbar";
import { hasTradedValue, snapshotRows } from "./arrange";
import { groupColor } from "./groupColors";
import { parseSettings, withSettings, type HeatmapSettings } from "./settings";
import "./heatmapPage.css";

export const SNAPSHOT_INTERVAL_MS = 60_000;

export interface HeatmapSection {
  key: string;
  title: string;
  symbols: readonly SymbolCode[];
  color: string;
}

export function heatmapSections(lists: readonly Watchlist[]): HeatmapSection[] {
  const several = lists.length > 1;
  return lists
    .flatMap((list) => list.groups.map((group: WatchGroup) => ({ key: group.id, title: several ? `${list.name} · ${group.name}` : group.name, symbols: group.symbols })))
    .map((section, index) => ({ ...section, color: groupColor(index) }));
}

function useBookTick(codes: readonly SymbolCode[]): number {
  const [tick, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const stops = codes.map((code) => quoteBook.subscribe(code, bump));
    return () => stops.forEach((stop) => stop());
  }, [codes]);
  return tick;
}

function freshestTime(snapshot: readonly Quote[], codes: readonly SymbolCode[]): number | null {
  const times = [...snapshot.map((quote) => quote.t), ...codes.flatMap((code) => quoteBook.get(code).quote?.t ?? [])];
  return times.length === 0 ? null : Math.max(...times);
}

export function HeatmapPage() {
  const [params, setParams] = useSearchParams();
  const settings = useMemo(() => parseSettings(params), [params]);
  const change = useCallback((next: HeatmapSettings) => setParams((current) => withSettings(current, next), { replace: true }), [setParams]);
  const lists = useWatchlistStore((s) => s.lists);
  const venue = useVenue();
  const sections = useMemo(() => heatmapSections(lists), [lists]);
  const codes = useMemo(() => [...new Set(sections.flatMap((section) => section.symbols))], [sections]);
  useEffect(() => (codes.length > 0 ? quoteBook.lease(codes) : undefined), [codes]);
  const tick = useBookTick(codes);
  const infos = useSymbolInfos(codes);
  const nameOf = useMemo(() => new Map(infos.map((info) => [info.code, info.name] as const)), [infos]);
  const snapshot = useQuery({
    queryKey: ["heatmap-quotes", venue, codes.join(",")],
    queryFn: ({ signal }) => fetchQuotes(codes, venue, signal),
    enabled: codes.length > 0,
    refetchInterval: SNAPSHOT_INTERVAL_MS,
    placeholderData: keepPreviousData,
  });
  const quotes = snapshot.data ?? [];
  const settled = snapshot.data !== undefined;
  const tradedKnown = useMemo(() => hasTradedValue(snapshotRows(codes, nameOf, quotes)), [codes, nameOf, quotes]);
  const latest = useMemo(() => freshestTime(quotes, codes), [quotes, codes, tick]);
  const freshness = latest === null ? "시세를 기다리는 중" : `시세 ${formatKstClockSeconds(latest)} 기준 · 자리는 1분마다 바꿈`;
  return (
    <PageFrame title="히트맵" freshness={freshness}>
      <HeatmapToolbar settings={settings} onChange={change} tradedKnown={!settled || tradedKnown} />
      {sections.length === 0 ? (
        <EmptyState title="관심종목 그룹이 없습니다">
          <p className="hm-empty-hint">히트맵은 관심종목 그룹마다 지도를 그립니다. 작업 영역의 관심종목 창에서 ‘새 그룹’을 만들고 종목을 넣으면 여기에 나타납니다.</p>
        </EmptyState>
      ) : settings.view === "flow" ? (
        <HeatmapFlow sections={sections} names={nameOf} venue={venue} />
      ) : (
        <div className="hm-groups">
          {sections.map((section) => (
            <HeatmapGroup key={section.key} section={section} settings={settings} names={nameOf} quotes={quotes} loading={!settled} />
          ))}
        </div>
      )}
    </PageFrame>
  );
}
