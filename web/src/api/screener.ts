import { useQuery, useQueryClient } from "@tanstack/react-query";
import { isUpdating } from "../lib/screener";
import type { Screen } from "./generated/Screen";
import type { ScreenerResult } from "./generated/ScreenerResult";
import type { ScreenerStatus } from "./generated/ScreenerStatus";
import type { ScreenerUpdateRequest } from "./generated/ScreenerUpdateRequest";
import type { Screens } from "./generated/Screens";
import { getJson, sendJson } from "./http";

const SCREENS_KEY = ["screens"] as const;
const STATUS_KEY = ["screener", "status"] as const;

export const runScreen = (screen: Screen) => sendJson<ScreenerResult>("POST", "/api/screener/run", JSON.stringify(screen));

export function useScreens() {
  return useQuery({ queryKey: SCREENS_KEY, queryFn: ({ signal }) => getJson<Screens>("/api/screens", signal) });
}

export function useScreenerStatus(pollWhileUpdatingMs: number) {
  return useQuery({
    queryKey: STATUS_KEY,
    queryFn: ({ signal }) => getJson<ScreenerStatus>("/api/screener/status", signal),
    refetchInterval: (query) => (isUpdating(query.state.data) ? pollWhileUpdatingMs : false),
  });
}

export function useUpdateCommands() {
  const client = useQueryClient();
  const show = (status: ScreenerStatus) => void client.setQueryData(STATUS_KEY, status);
  return {
    start: (full: boolean) =>
      sendJson<ScreenerStatus>("POST", "/api/screener/update", JSON.stringify({ full } satisfies ScreenerUpdateRequest)).then(show),
    cancel: () => sendJson<ScreenerStatus>("POST", "/api/screener/update/cancel", "{}").then(show),
    refresh: () => client.invalidateQueries({ queryKey: STATUS_KEY }),
  };
}
