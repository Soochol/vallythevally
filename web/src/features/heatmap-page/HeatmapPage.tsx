import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useReducer } from "react";
import { useSearchParams } from "react-router";
import type { HeatmapBoardTheme } from "../../api/generated/HeatmapBoardTheme";
import type { SymbolCode } from "../../api/generated/SymbolCode";
import { heatmapBoardQuery } from "../../api/heatmapBoard";
import { useSymbolInfos } from "../../api/queries";
import { formatKstClockSeconds } from "../../chart/time";
import { quoteBook } from "../../stores/realtime";
import { useVenue } from "../../stores/ui";
import { EmptyState } from "../overlay/State";
import { PageFrame } from "../pages/PageFrame";
import { HeatmapFlow } from "./HeatmapFlow";
import { HeatmapGroup } from "./HeatmapGroup";
import { HeatmapToolbar } from "./HeatmapToolbar";
import { boardRows, hasTradedValue } from "./arrange";
import { themeColors } from "./groupColors";
import { parseSettings, withSettings, type HeatmapSettings } from "./settings";
import "./heatmapPage.css";

export interface HeatmapSection {
  key: string;
  title: string;
  symbols: readonly SymbolCode[];
  color: string;
  theme: HeatmapBoardTheme;
}

export function heatmapSections(themes: readonly HeatmapBoardTheme[]): HeatmapSection[] {
  const colors = themeColors(themes.map((theme) => theme.id));
  return themes.map((theme) => ({ key: theme.id, title: theme.name, symbols: [...theme.members.map((m) => m.symbol), ...theme.missing], color: colors.get(theme.id)!, theme }));
}

function useBookTick(codes: readonly SymbolCode[]): number {
  const [tick, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const stops = codes.map((code) => quoteBook.subscribe(code, bump));
    return () => stops.forEach((stop) => stop());
  }, [codes]);
  return tick;
}

function freshestTime(asOf: number | null, codes: readonly SymbolCode[]): number | null {
  const times = [...(asOf === null ? [] : [asOf]), ...codes.flatMap((code) => quoteBook.get(code).quote?.t ?? [])];
  return times.length === 0 ? null : Math.max(...times);
}

export function HeatmapPage() {
  const [params, setParams] = useSearchParams();
  const settings = useMemo(() => parseSettings(params), [params]);
  const change = useCallback((next: HeatmapSettings) => setParams((current) => withSettings(current, next), { replace: true }), [setParams]);
  const venue = useVenue();
  const board = useQuery(heatmapBoardQuery(venue, settings.order));
  const sections = useMemo(() => heatmapSections(board.data?.themes ?? []), [board.data]);
  const codes = useMemo(() => [...new Set(sections.flatMap((section) => section.symbols))], [sections]);
  useEffect(() => (codes.length > 0 ? quoteBook.lease(codes) : undefined), [codes]);
  const tick = useBookTick(codes);
  const infos = useSymbolInfos(codes);
  const nameOf = useMemo(() => {
    const names = new Map(infos.map((info) => [info.code, info.name] as const));
    for (const section of sections) for (const member of section.theme.members) names.set(member.symbol, member.name);
    return names;
  }, [infos, sections]);
  const settled = board.data !== undefined;
  const tradedKnown = useMemo(() => hasTradedValue(sections.flatMap((section) => boardRows(section.theme, nameOf))), [sections, nameOf]);
  const latest = useMemo(() => freshestTime(board.data?.asOf ?? null, codes), [board.data, codes, tick]);
  const freshness = latest === null ? "시세를 기다리는 중" : `시세 ${formatKstClockSeconds(latest)} 기준 · 자리는 1분마다 바꿈`;
  return (
    <PageFrame title="히트맵" freshness={freshness}>
      <HeatmapToolbar settings={settings} onChange={change} tradedKnown={!settled || tradedKnown} />
      {settled && sections.length === 0 ? (
        <EmptyState title="테마가 없습니다">
          <p className="hm-empty-hint">히트맵은 내가 고른 종목 묶음인 테마마다 지도를 그립니다. 테마를 만들고 종목을 넣으면 여기에 나타납니다.</p>
        </EmptyState>
      ) : settings.view === "flow" ? (
        <HeatmapFlow sections={sections} names={nameOf} venue={venue} />
      ) : (
        <div className="hm-groups">
          {sections.map((section) => (
            <HeatmapGroup key={section.key} section={section} settings={settings} names={nameOf} />
          ))}
        </div>
      )}
    </PageFrame>
  );
}
