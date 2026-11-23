import { keepPreviousData, queryOptions } from "@tanstack/react-query";
import type { HeatmapBoard } from "./generated/HeatmapBoard";
import type { HeatmapSource } from "./generated/HeatmapSource";
import type { HeatmapThemeOrder } from "./generated/HeatmapThemeOrder";
import type { Venue } from "./generated/Venue";
import { getJson } from "./http";

export const HEATMAP_BOARD_REFRESH_MS = 30_000;

export const heatmapBoardQuery = (venue: Venue, order: HeatmapThemeOrder, source: HeatmapSource) =>
  queryOptions({
    queryKey: ["heatmap-board", venue, order, source],
    queryFn: ({ signal }) => getJson<HeatmapBoard>(`/api/heatmap/board?venue=${venue}&order=${order}&source=${source}`, signal),
    refetchInterval: HEATMAP_BOARD_REFRESH_MS,
    placeholderData: keepPreviousData,
  });
