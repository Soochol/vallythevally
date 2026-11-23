import { create } from "zustand";
import type { Broker } from "../api/generated/Broker";
import type { KiwoomLinkStatus } from "../api/generated/KiwoomLinkStatus";
import type { MarketSourceStatus } from "../api/generated/MarketSourceStatus";

const KIS_MESSAGE: Record<KiwoomLinkStatus["state"], string> = {
  noKey: "한투 키가 없습니다",
  disconnected: "한투에 연결하지 않았습니다",
  connecting: "한투에 연결하는 중입니다",
  connected: "한투에 연결되어 있습니다",
  failed: "한투에 연결하지 못했습니다",
};

export function marketLinkOf(kiwoom: KiwoomLinkStatus | null, source: MarketSourceStatus | null): KiwoomLinkStatus | null {
  if (source === null || source.broker === "kiwoom") return kiwoom;
  return {
    environment: kiwoom?.environment ?? "real",
    keySource: source.state === "noKey" ? "none" : "file",
    appKeyTail: null,
    credentialId: null,
    state: source.state,
    problem: source.problem,
    message: KIS_MESSAGE[source.state],
    retryAt: source.retryAt,
    needsAcknowledgement: false,
    step: source.step,
    tokenExpiresAt: null,
    realtimeRegistered: null,
    symbolCount: null,
    registeredIp: null,
    atStart: null,
  };
}

interface KiwoomLinkStore {
  status: KiwoomLinkStatus | null;
  kiwoom: KiwoomLinkStatus | null;
  source: MarketSourceStatus | null;
  pushes: number;
  sourcePushes: number;
  receivePush(status: KiwoomLinkStatus): void;
  receiveSnapshot(status: KiwoomLinkStatus, pushesAtRequest: number): void;
  receiveSourcePush(source: MarketSourceStatus): void;
  receiveSourceSnapshot(source: MarketSourceStatus, pushesAtRequest: number): void;
}

export const useKiwoomLinkStore = create<KiwoomLinkStore>()((set) => ({
  status: null,
  kiwoom: null,
  source: null,
  pushes: 0,
  sourcePushes: 0,
  receivePush: (status) => set((s) => ({ kiwoom: status, status: marketLinkOf(status, s.source), pushes: s.pushes + 1 })),
  receiveSnapshot: (status, pushesAtRequest) => set((s) => (s.pushes === pushesAtRequest ? { kiwoom: status, status: marketLinkOf(status, s.source) } : s)),
  receiveSourcePush: (source) => set((s) => ({ source, status: marketLinkOf(s.kiwoom, source), sourcePushes: s.sourcePushes + 1 })),
  receiveSourceSnapshot: (source, pushesAtRequest) => set((s) => (s.sourcePushes === pushesAtRequest ? { source, status: marketLinkOf(s.kiwoom, source) } : s)),
}));

export const isMockEnvironment = (): boolean => useKiwoomLinkStore.getState().status?.environment === "mock";
export const useMockEnvironment = (): boolean => useKiwoomLinkStore((s) => s.status?.environment === "mock");

export const receiveKiwoomLinkPush = (status: KiwoomLinkStatus) => useKiwoomLinkStore.getState().receivePush(status);
export const receiveMarketSourcePush = (source: MarketSourceStatus) => useKiwoomLinkStore.getState().receiveSourcePush(source);

export const useMarketSource = (): MarketSourceStatus | null => useKiwoomLinkStore((s) => s.source);
export const useSourceBroker = (): Broker => useKiwoomLinkStore((s) => s.source?.broker ?? "kiwoom");
const kiwoomReceivesFeed = (s: Pick<KiwoomLinkStore, "source">): boolean => s.source !== null && s.source.broker !== "kiwoom" && s.source.feedBroker?.broker === "kiwoom";
export const useFeedLink = (): KiwoomLinkStatus | null => useKiwoomLinkStore((s) => (kiwoomReceivesFeed(s) ? null : s.status));
export const useKiwoomOnlyLink = (): KiwoomLinkStatus | null => useKiwoomLinkStore((s) => s.kiwoom);
