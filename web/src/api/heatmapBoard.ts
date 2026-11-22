import { keepPreviousData, queryOptions } from "@tanstack/react-query";
import type { HeatmapBoard } from "./generated/HeatmapBoard";
import type { HeatmapThemeOrder } from "./generated/HeatmapThemeOrder";
import type { Venue } from "./generated/Venue";
import { getJson } from "./http";

export const HEATMAP_BOARD_REFRESH_MS = 60_000;

export const heatmapBoardQuery = (venue: Venue, order: HeatmapThemeOrder) =>
  queryOptions({
    queryKey: ["heatmap-board", venue, order],
    queryFn: ({ signal }) => getJson<HeatmapBoard>(`/api/heatmap/board?venue=${venue}&order=${order}`, signal),
    refetchInterval: HEATMAP_BOARD_REFRESH_MS,
    placeholderData: keepPreviousData,
  });
