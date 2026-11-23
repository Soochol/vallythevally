import { beforeEach, describe, expect, test } from "vitest";
import type { KiwoomLinkStatus } from "../api/generated/KiwoomLinkStatus";
import { linkDotTone } from "../features/system-settings/linkDot";
import { MarketSocket, type Connect } from "../api/socket";
import type { MarketSourceStatus } from "../api/generated/MarketSourceStatus";
import { marketLinkOf, receiveKiwoomLinkPush, receiveMarketSourcePush, useKiwoomLinkStore } from "./kiwoomLink";

const status = (patch: Partial<KiwoomLinkStatus>): KiwoomLinkStatus => ({
  environment: "real", keySource: "file", appKeyTail: "1234", registeredIp: null, credentialId: null, state: "disconnected", problem: null, message: "연결하지 않았습니다",
  retryAt: null, needsAcknowledgement: false, step: null, tokenExpiresAt: null, realtimeRegistered: null, symbolCount: null, atStart: "connects", ...patch,
});

beforeEach(() => useKiwoomLinkStore.setState({ status: null, kiwoom: null, source: null, pushes: 0, sourcePushes: 0 }));

describe("키움 연결 상태 저장소", () => {
  test("WebSocket의 kiwoom_link 메시지가 상태를 바꾼다", () => {
    let on: Parameters<Connect>[1] | undefined;
    const socket = new MarketSocket({ url: () => "ws://test/api/ws", connect: (_url, events) => ((on = events), { send() {}, close() {} }), onKiwoomLink: receiveKiwoomLinkPush });
    socket.start();
    on!.message(JSON.stringify({ type: "kiwoom_link", status: status({ state: "connected", message: "연결됨" }) }));
    expect(useKiwoomLinkStore.getState().status?.state).toBe("connected");
    on!.message(JSON.stringify({ type: "kiwoom_link", status: status({ state: "noKey", keySource: "none", message: "키가 없습니다" }) }));
    expect(useKiwoomLinkStore.getState().status?.message).toBe("키가 없습니다");
  });

  test("요청하는 사이 메시지가 왔으면 GET 응답은 버린다", () => {
    const { receivePush, receiveSnapshot } = useKiwoomLinkStore.getState();
    const before = useKiwoomLinkStore.getState().pushes;
    receivePush(status({ state: "connected" }));
    receiveSnapshot(status({ state: "disconnected" }), before);
    expect(useKiwoomLinkStore.getState().status?.state).toBe("connected");
  });

  test("메시지가 없었으면 GET 응답을 받아들인다", () => {
    useKiwoomLinkStore.getState().receiveSnapshot(status({ state: "noKey" }), 0);
    expect(useKiwoomLinkStore.getState().status?.state).toBe("noKey");
  });
});

describe("상태 점 색", () => {
  test.each([
    [null, "gray"],
    [status({ state: "noKey" }), "gray"],
    [status({ state: "disconnected" }), "gray"],
    [status({ state: "connecting" }), "amber"],
    [status({ state: "connected" }), "mint"],
    [status({ state: "failed", problem: "issueIntervalWait" }), "amber"],
    [status({ state: "failed", problem: "authUncertain" }), "amber"],
    [status({ state: "failed", problem: "network" }), "amber"],
    [status({ state: "failed", problem: "authBlocked8050" }), "red"],
    [status({ state: "failed", problem: "keyNeedsCheck" }), "red"],
    [status({ state: "failed", problem: "tokenFileUnusable" }), "red"],
  ] as const)("%j → %s", (link, tone) => expect(linkDotTone(link)).toBe(tone));
});

const kisSource = (patch: Partial<MarketSourceStatus> = {}): MarketSourceStatus => ({ broker: "kis", keyId: "kis1", alias: "한투 1", state: "connected", problem: null, step: null, retryAt: null, features: [], feedBroker: null, ...patch });

describe("시세 공급원 상태", () => {
  test("공급원이 한투이면 화면이 읽는 연결 상태는 공급원 상태를 따르고 키움 상태는 따로 남는다", () => {
    receiveKiwoomLinkPush(status({ state: "noKey", keySource: "none", message: "키가 없습니다" }));
    expect(useKiwoomLinkStore.getState().status?.state).toBe("noKey");
    receiveMarketSourcePush(kisSource());
    expect(useKiwoomLinkStore.getState().status).toMatchObject({ state: "connected", message: "한투에 연결되어 있습니다" });
    expect(useKiwoomLinkStore.getState().kiwoom?.state).toBe("noKey");
    receiveMarketSourcePush(kisSource({ broker: "kiwoom" }));
    expect(useKiwoomLinkStore.getState().status?.state).toBe("noKey");
  });
  test("공급원을 아직 모르거나 키움이면 키움 상태 그대로다", () => {
    const kiwoom = status({ state: "connected" });
    expect(marketLinkOf(kiwoom, null)).toBe(kiwoom);
    expect(marketLinkOf(kiwoom, kisSource({ broker: "kiwoom" }))).toBe(kiwoom);
    expect(marketLinkOf(null, kisSource({ state: "failed", problem: "network" }))).toMatchObject({ state: "failed", problem: "network", environment: "real" });
  });
  test("요청하는 사이 공급원 메시지가 왔으면 GET 응답은 버린다", () => {
    const { receiveSourcePush, receiveSourceSnapshot } = useKiwoomLinkStore.getState();
    receiveSourcePush(kisSource());
    receiveSourceSnapshot(kisSource({ state: "disconnected" }), 0);
    expect(useKiwoomLinkStore.getState().source?.state).toBe("connected");
  });
  test("WebSocket의 market_source 메시지가 공급원 상태를 바꾼다", () => {
    let on: Parameters<Connect>[1] | undefined;
    const socket = new MarketSocket({ url: () => "ws://test/api/ws", connect: (_url, events) => ((on = events), { send() {}, close() {} }), onMarketSource: receiveMarketSourcePush });
    socket.start();
    on!.message(JSON.stringify({ type: "market_source", status: kisSource({ state: "disconnected" }) }));
    expect(useKiwoomLinkStore.getState().source).toMatchObject({ broker: "kis", state: "disconnected" });
  });
});
