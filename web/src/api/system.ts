import { type QueryClient, useQuery } from "@tanstack/react-query";
import { isPublicMode } from "../public-mode/serverMode";
import { receiveKiwoomLinkPush, useKiwoomLinkStore } from "../stores/kiwoomLink";
import type { KiwoomLinkStatus } from "./generated/KiwoomLinkStatus";
import type { MarketSourceStatus } from "./generated/MarketSourceStatus";
import type { SystemSettings } from "./generated/SystemSettings";
import type { KiwoomConnectInput } from "./generated/KiwoomConnectInput";
import type { KiwoomKeyAdd } from "./generated/KiwoomKeyAdd";
import type { KiwoomKeyAlias } from "./generated/KiwoomKeyAlias";
import type { KiwoomKeyInput } from "./generated/KiwoomKeyInput";
import type { KiwoomKeyList } from "./generated/KiwoomKeyList";
import type { KiwoomMarketKeyInput } from "./generated/KiwoomMarketKeyInput";
import type { KiwoomUsage } from "./generated/KiwoomUsage";
import type { OrdersAccountCheck } from "./generated/OrdersAccountCheck";
import type { OrdersStatus } from "./generated/OrdersStatus";
import type { OrdersSwitchInput } from "./generated/OrdersSwitchInput";
import type { PublicIpCheck } from "./generated/PublicIpCheck";
import type { RegisteredIpInput } from "./generated/RegisteredIpInput";
import { getJson, putJson, sendJson } from "./http";

export async function loadKiwoomLink(signal?: AbortSignal): Promise<void> {
  if (isPublicMode()) return;
  await Promise.all([loadKiwoomStatus(signal), loadMarketSource(signal)]);
}

async function loadKiwoomStatus(signal?: AbortSignal): Promise<void> {
  const pushesAtRequest = useKiwoomLinkStore.getState().pushes;
  try {
    const status = await getJson<KiwoomLinkStatus>("/api/system/kiwoom", signal);
    useKiwoomLinkStore.getState().receiveSnapshot(status, pushesAtRequest);
  } catch {
    return;
  }
}

async function loadMarketSource(signal?: AbortSignal): Promise<void> {
  const pushesAtRequest = useKiwoomLinkStore.getState().sourcePushes;
  try {
    const source = await getJson<MarketSourceStatus>("/api/system/market-source", signal);
    useKiwoomLinkStore.getState().receiveSourceSnapshot(source, pushesAtRequest);
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
  const current = useKiwoomLinkStore.getState().kiwoom;
  if (current) receiveKiwoomLinkPush({ ...current, registeredIp });
}
export const checkPublicIp = () => sendJson<PublicIpCheck>("POST", `${KIWOOM}/ip-check`, "{}");

export const KIWOOM_KEYS_QUERY_KEY = ["system", "kiwoom-keys"] as const;
const KEYS = `${KIWOOM}/keys`;
const keyPath = (keyId: string, tail = "") => `${KEYS}/${encodeURIComponent(keyId)}${tail}`;

export function useKiwoomKeys(refreshMs: number) {
  return useQuery({ queryKey: KIWOOM_KEYS_QUERY_KEY, queryFn: ({ signal }) => getJson<KiwoomKeyList>(KEYS, signal), refetchInterval: refreshMs, staleTime: 0 });
}
export async function storeKiwoomKeys(queryClient: QueryClient, list: KiwoomKeyList): Promise<void> {
  await queryClient.cancelQueries({ queryKey: KIWOOM_KEYS_QUERY_KEY });
  queryClient.setQueryData(KIWOOM_KEYS_QUERY_KEY, list);
  void queryClient.invalidateQueries({ queryKey: ORDERS_QUERY_KEY });
}
export const addKiwoomKey = (input: KiwoomKeyAdd) => sendJson<KiwoomKeyList>("POST", KEYS, JSON.stringify(input));
export const renameKiwoomKey = (keyId: string, input: KiwoomKeyAlias) => putJson<KiwoomKeyList>(keyPath(keyId, "/alias"), input);
export const replaceKiwoomKey = (keyId: string, input: KiwoomKeyInput) => putJson<KiwoomKeyList>(keyPath(keyId, "/key"), input);
export const removeKiwoomKey = (keyId: string) => sendJson<KiwoomKeyList>("DELETE", keyPath(keyId), "{}");
export const designateMarketKey = (input: KiwoomMarketKeyInput) => putJson<KiwoomKeyList>(`${KIWOOM}/market-key`, input);
export const connectKiwoomKey = (keyId: string, input: KiwoomConnectInput) => sendJson<KiwoomKeyList>("POST", keyPath(keyId, "/connect"), JSON.stringify(input));
export const disconnectKiwoomKey = (keyId: string) => sendJson<KiwoomKeyList>("POST", keyPath(keyId, "/disconnect"), "{}");

const ORDERS = "/api/system/orders";
export const ORDERS_QUERY_KEY = ["system", "orders"] as const;

export function useOrdersStatus() {
  return useQuery({ queryKey: ORDERS_QUERY_KEY, queryFn: ({ signal }) => getJson<OrdersStatus>(ORDERS, signal), staleTime: Infinity });
}
export const checkOrdersAccount = (keyId: string) => sendJson<OrdersAccountCheck>("POST", `${ORDERS}/check-account?keyId=${encodeURIComponent(keyId)}`, "{}");
export const switchOrders = (input: OrdersSwitchInput) => putJson<OrdersStatus>(ORDERS, input);

export function useKiwoomUsage(refreshMs: number) {
  return useQuery({ queryKey: ["system", "kiwoom-usage"], queryFn: ({ signal }) => getJson<KiwoomUsage>(`${KIWOOM}/usage`, signal), refetchInterval: refreshMs, staleTime: 0 });
}
