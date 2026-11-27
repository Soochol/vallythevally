import { queryOptions, useQuery } from "@tanstack/react-query";
import type { KiwoomThemeList } from "./generated/KiwoomThemeList";
import type { KiwoomThemeMembers } from "./generated/KiwoomThemeMembers";
import { getJson } from "./http";

const LIST_STALE_MS = 30_000;
const MEMBERS_STALE_MS = 20_000;

export function fetchKiwoomThemes(periodDays = 1, signal?: AbortSignal): Promise<KiwoomThemeList> {
  return getJson<KiwoomThemeList>(`/api/kiwoom-themes?periodDays=${periodDays}`, signal);
}

export function fetchKiwoomThemeMembers(code: string, periodDays = 1, signal?: AbortSignal): Promise<KiwoomThemeMembers> {
  return getJson<KiwoomThemeMembers>(`/api/kiwoom-themes/${encodeURIComponent(code)}?periodDays=${periodDays}`, signal);
}

export function kiwoomThemesQuery(periodDays = 1) {
  return queryOptions({
    queryKey: ["kiwoom-themes", periodDays] as const,
    queryFn: ({ signal }) => fetchKiwoomThemes(periodDays, signal),
    staleTime: LIST_STALE_MS,
    refetchInterval: 45_000,
    retry: false,
  });
}

export function kiwoomThemeMembersQuery(code: string, enabled: boolean, periodDays = 1) {
  return queryOptions({
    queryKey: ["kiwoom-themes", "members", code, periodDays] as const,
    queryFn: ({ signal }) => fetchKiwoomThemeMembers(code, periodDays, signal),
    enabled,
    staleTime: MEMBERS_STALE_MS,
    refetchInterval: enabled ? 30_000 : false,
    retry: false,
  });
}

export function useKiwoomThemes(periodDays = 1) {
  return useQuery(kiwoomThemesQuery(periodDays));
}

export function useKiwoomThemeMembers(code: string, enabled: boolean, periodDays = 1) {
  return useQuery(kiwoomThemeMembersQuery(code, enabled, periodDays));
}
