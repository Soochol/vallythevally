import { useQuery } from "@tanstack/react-query";
import { useAccountStore } from "../stores/account";
import type { CollectorAccess } from "./generated/CollectorAccess";
import type { CollectorCoverage } from "./generated/CollectorCoverage";
import type { CollectorDisk } from "./generated/CollectorDisk";
import type { CollectorStatusPage } from "./generated/CollectorStatusPage";
import { getJson } from "./http";

const COLLECTOR = "/api/collector";
export const STATUS_REFRESH_MS = 5_000;
export const SLOW_REFRESH_MS = 30_000;

export function loginKey(status: ReturnType<typeof useAccountStore.getState>["status"]): string | null {
  if (!status) return null;
  return status.state === "signed_in" || status.state === "owner_mismatch" ? `${status.provider}:${status.accountId}` : status.state;
}

export function useCollectorAccess() {
  const login = loginKey(useAccountStore((s) => s.status));
  return useQuery({
    queryKey: ["collector", "access", login],
    queryFn: ({ signal }) => getJson<CollectorAccess>(`${COLLECTOR}/access`, signal),
    enabled: login !== null,
  });
}

export const collectorAllowed = (access: ReturnType<typeof useCollectorAccess>): boolean => access.data?.access === "allowed";

export function useCollectorStatus() {
  return useQuery({
    queryKey: ["collector", "status"],
    queryFn: ({ signal }) => getJson<CollectorStatusPage>(`${COLLECTOR}/status`, signal),
    refetchInterval: STATUS_REFRESH_MS,
  });
}

export function useCollectorCoverage() {
  return useQuery({
    queryKey: ["collector", "coverage"],
    queryFn: ({ signal }) => getJson<CollectorCoverage>(`${COLLECTOR}/coverage`, signal),
    refetchInterval: SLOW_REFRESH_MS,
  });
}

export function useCollectorDisk() {
  return useQuery({
    queryKey: ["collector", "disk"],
    queryFn: ({ signal }) => getJson<CollectorDisk>(`${COLLECTOR}/disk`, signal),
    refetchInterval: SLOW_REFRESH_MS,
  });
}
