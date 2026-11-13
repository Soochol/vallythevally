import { type QueryClient, queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import { isUpdating, msUntilStatusTurns } from "../lib/screener";
import type { Revision } from "./generated/Revision";
import type { Screen } from "./generated/Screen";
import type { ScreenerResult } from "./generated/ScreenerResult";
import type { ScreenerStatus } from "./generated/ScreenerStatus";
import type { ScreenerUpdateRequest } from "./generated/ScreenerUpdateRequest";
import type { Screens } from "./generated/Screens";
import { ApiRequestError, getJson, putJson, sendJson } from "./http";

const SCREENS_KEY = ["screens"] as const;
const STATUS_KEY = ["screener", "status"] as const;

export const runScreen = (screen: Screen) => sendJson<ScreenerResult>("POST", "/api/screener/run", JSON.stringify(screen));

export const screensQuery = queryOptions({ queryKey: SCREENS_KEY, queryFn: ({ signal }) => getJson<Screens>("/api/screens", signal) });

export const useScreens = () => useQuery(screensQuery);

export type SaveOutcome = { kind: "ok"; saved: Screens } | { kind: "stale"; latest: Screens };

export async function saveScreens(client: QueryClient, screens: Screen[], base: Revision): Promise<SaveOutcome> {
  try {
    const saved = await putJson<Screens>("/api/screens", { screens, revision: base + 1 } satisfies Screens);
    await client.cancelQueries({ queryKey: SCREENS_KEY });
    client.setQueryData(SCREENS_KEY, saved);
    return { kind: "ok", saved };
  } catch (e) {
    if (!(e instanceof ApiRequestError && e.code === "stale_revision")) throw e;
    return { kind: "stale", latest: await client.fetchQuery({ ...screensQuery, staleTime: 0 }) };
  }
}

export const screenerStatusQuery = (pollWhileUpdatingMs: number) =>
  queryOptions({
    queryKey: STATUS_KEY,
    queryFn: ({ signal }) => getJson<ScreenerStatus>("/api/screener/status", signal),
    refetchInterval: (query) => (isUpdating(query.state.data) ? pollWhileUpdatingMs : msUntilStatusTurns(Date.now())),
    refetchOnWindowFocus: true,
  });

export const useScreenerStatus = (pollWhileUpdatingMs: number) => useQuery(screenerStatusQuery(pollWhileUpdatingMs));

export function screenerCommands(client: QueryClient) {
  const command = async (path: string, body: string) => {
    const status = await sendJson<ScreenerStatus>("POST", path, body);
    await client.cancelQueries({ queryKey: STATUS_KEY });
    client.setQueryData(STATUS_KEY, status);
    void client.invalidateQueries({ queryKey: STATUS_KEY });
  };
  return {
    start: (full: boolean) => command("/api/screener/update", JSON.stringify({ full } satisfies ScreenerUpdateRequest)),
    cancel: () => command("/api/screener/update/cancel", "{}"),
    refresh: () => client.invalidateQueries({ queryKey: STATUS_KEY }),
  };
}

export const useUpdateCommands = () => screenerCommands(useQueryClient());
