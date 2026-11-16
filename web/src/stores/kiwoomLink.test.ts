import { beforeEach, describe, expect, test } from "vitest";
import type { KiwoomLinkStatus } from "../api/generated/KiwoomLinkStatus";
import { linkDotTone } from "../features/system-settings/linkDot";
import { MarketSocket, type Connect } from "../api/socket";
import { receiveKiwoomLinkPush, useKiwoomLinkStore } from "./kiwoomLink";

const status = (patch: Partial<KiwoomLinkStatus>): KiwoomLinkStatus => ({
  keySource: "file", appKeyTail: "1234", credentialId: null, state: "disconnected", problem: null, message: "연결하지 않았습니다",
  retryAt: null, needsAcknowledgement: false, step: null, tokenExpiresAt: null, realtimeRegistered: null, symbolCount: null, ...patch,
});

beforeEach(() => useKiwoomLinkStore.setState({ status: null, pushes: 0 }));

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
