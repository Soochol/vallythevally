import { useQuery } from "@tanstack/react-query";
import { useKiwoomLinkStore } from "../stores/kiwoomLink";
import type { KiwoomLinkStatus } from "./generated/KiwoomLinkStatus";
import type { SystemSettings } from "./generated/SystemSettings";
import { getJson } from "./http";

export async function loadKiwoomLink(signal?: AbortSignal): Promise<void> {
  const pushesAtRequest = useKiwoomLinkStore.getState().pushes;
  try {
    const status = await getJson<KiwoomLinkStatus>("/api/system/kiwoom", signal);
    useKiwoomLinkStore.getState().receiveSnapshot(status, pushesAtRequest);
  } catch {
    return;
  }
}

export function useSystemSettings() {
  return useQuery({
    queryKey: ["system", "settings"],
    queryFn: ({ signal }) => getJson<SystemSettings>("/api/system/settings", signal),
    staleTime: Infinity,
  });
}
