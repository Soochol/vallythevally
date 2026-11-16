import { useQuery } from "@tanstack/react-query";
import { receiveKiwoomLinkPush, useKiwoomLinkStore } from "../stores/kiwoomLink";
import type { KiwoomLinkStatus } from "./generated/KiwoomLinkStatus";
import type { SystemSettings } from "./generated/SystemSettings";
import type { KiwoomConnectInput } from "./generated/KiwoomConnectInput";
import type { KiwoomKeyInput } from "./generated/KiwoomKeyInput";
import type { PublicIpCheck } from "./generated/PublicIpCheck";
import type { RegisteredIpInput } from "./generated/RegisteredIpInput";
import { getJson, putJson, sendJson } from "./http";

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

const KIWOOM = "/api/system/kiwoom";

async function applyLink(run: () => Promise<KiwoomLinkStatus>): Promise<void> {
  const pushesAtRequest = useKiwoomLinkStore.getState().pushes;
  useKiwoomLinkStore.getState().receiveSnapshot(await run(), pushesAtRequest);
}

const post = (path: string, body: unknown = {}) => sendJson<KiwoomLinkStatus>("POST", path, JSON.stringify(body));

export const saveKiwoomKey = (input: KiwoomKeyInput) => applyLink(() => putJson<KiwoomLinkStatus>(`${KIWOOM}/key`, input));
export const deleteKiwoomKey = () => applyLink(() => sendJson<KiwoomLinkStatus>("DELETE", `${KIWOOM}/key`, "{}"));
export const connectKiwoom = (input: KiwoomConnectInput) => applyLink(() => post(`${KIWOOM}/connect`, input));
export const disconnectKiwoom = () => applyLink(() => post(`${KIWOOM}/disconnect`));
export const recheckKiwoomTokenFile = () => applyLink(() => post(`${KIWOOM}/recheck-token-file`));
export async function saveRegisteredIp(input: RegisteredIpInput): Promise<void> {
  const { registeredIp } = await putJson<KiwoomLinkStatus>(`${KIWOOM}/registered-ip`, input);
  const current = useKiwoomLinkStore.getState().status;
  if (current) receiveKiwoomLinkPush({ ...current, registeredIp });
}
export const checkPublicIp = () => sendJson<PublicIpCheck>("POST", `${KIWOOM}/ip-check`, "{}");
