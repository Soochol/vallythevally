import { keepPreviousData, queryOptions } from "@tanstack/react-query";
import type { HeatmapFlowSeries } from "./generated/HeatmapFlowSeries";
import type { SymbolCode } from "./generated/SymbolCode";
import type { Venue } from "./generated/Venue";
import { withNotInThemesMissing } from "../public-mode/flowMissing";
import { FlowRefresh } from "../public-mode/flowSchedule";
import { isPublicMode } from "../public-mode/serverMode";
import { getJson } from "./http";

export const HEATMAP_FLOW_REFRESH_MS = 60_000;

const publicFlowRefresh = new FlowRefresh(() => Date.now(), Math.random);

export const heatmapFlowQuery = (symbols: readonly SymbolCode[], venue: Venue) =>
  queryOptions({
    queryKey: ["heatmap-flow", venue, symbols.join(",")],
    queryFn: ({ signal }) => getJson<HeatmapFlowSeries>(`/api/heatmap/flow?symbols=${symbols.map(encodeURIComponent).join(",")}&venue=${venue}`, signal),
    refetchInterval: (query) => (isPublicMode() ? publicFlowRefresh.intervalMs(query) : HEATMAP_FLOW_REFRESH_MS),
    select: withNotInThemesMissing,
    placeholderData: keepPreviousData,
  });
