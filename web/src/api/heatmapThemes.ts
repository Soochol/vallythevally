import { type QueryClient, queryOptions } from "@tanstack/react-query";
import { nextRevision, sameThemes } from "../lib/heatmapThemes";
import type { HeatmapTheme } from "./generated/HeatmapTheme";
import type { HeatmapThemes } from "./generated/HeatmapThemes";
import type { Revision } from "./generated/Revision";
import { ApiRequestError, getJson, putJson } from "./http";

export const HEATMAP_THEMES_PATH = "/api/heatmap/themes";

const THEMES_KEY = ["heatmap-themes"] as const;
const BOARD_KEY = ["heatmap-board"] as const;

export const heatmapThemesQuery = queryOptions({
  queryKey: THEMES_KEY,
  queryFn: ({ signal }) => getJson<HeatmapThemes>(HEATMAP_THEMES_PATH, signal),
});

export const fetchLatestThemes = (client: QueryClient) => client.fetchQuery({ ...heatmapThemesQuery, staleTime: 0 });

export const isStaleRevision = (error: unknown): boolean => error instanceof ApiRequestError && error.code === "stale_revision";

export async function saveHeatmapThemes(client: QueryClient, themes: HeatmapTheme[], stored: Revision): Promise<HeatmapThemes> {
  const saved = await putJson<HeatmapThemes>(HEATMAP_THEMES_PATH, { themes, revision: nextRevision(stored) } satisfies HeatmapThemes);
  await client.cancelQueries({ queryKey: THEMES_KEY });
  client.setQueryData(THEMES_KEY, saved);
  await client.invalidateQueries({ queryKey: BOARD_KEY });
  return saved;
}

export interface ThemeChange<R> {
  themes: HeatmapTheme[];
  result: R;
}

export async function changeThemesNow<R>(client: QueryClient, change: (themes: HeatmapTheme[]) => ThemeChange<R>): Promise<{ saved: boolean; result: R }> {
  for (let attempt = 0; ; attempt += 1) {
    const latest = await fetchLatestThemes(client);
    const { themes, result } = change(latest.themes);
    if (sameThemes(themes, latest.themes)) return { saved: false, result };
    try {
      await saveHeatmapThemes(client, themes, latest.revision);
      return { saved: true, result };
    } catch (error) {
      if (attempt > 0 || !isStaleRevision(error)) throw error;
    }
  }
}
