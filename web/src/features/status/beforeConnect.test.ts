import { describe, expect, it } from "vitest";
import type { KiwoomLinkStatus } from "../../api/generated/KiwoomLinkStatus";
import { beforeConnect } from "./beforeConnect";

const link = (patch: Partial<KiwoomLinkStatus>): KiwoomLinkStatus => ({
  environment: "real", keySource: "file", appKeyTail: "1234", credentialId: null, state: "disconnected", problem: null, message: "서버 문장", retryAt: null, needsAcknowledgement: false,
  step: null, tokenExpiresAt: null, realtimeRegistered: null, symbolCount: null, registeredIp: null, atStart: "connects", ...patch,
});

describe("차트 칸 연결 안내", () => {
  it("연결 안 함은 연결 단추를 주고, 끊어 둔 상태만 다음 시작 안내를 더한다", () => {
    expect(beforeConnect(link({ atStart: "connects" }))).toMatchObject({ action: { kind: "connect" }, note: null, canOpenSettings: false });
    expect(beforeConnect(link({ atStart: "keptDisconnected" }))).toMatchObject({ action: { kind: "connect" }, note: "연결하면 다음부터 서버를 켤 때 자동으로 연결합니다" });
  });
  it("연결 중은 단계 이름을, 대기 단계는 아무것도 보내지 않는다는 안내와 시각을 준다", () => {
    expect(beforeConnect(link({ state: "connecting", step: "token" }))).toMatchObject({ title: "키움에 연결하는 중입니다", detail: "단계 · 토큰", action: null });
    expect(beforeConnect(link({ state: "connecting", step: "issueInterval", retryAt: 900 }))).toMatchObject({
      waitingUntil: { retryAt: 900 }, note: "기다리는 동안 키움에 아무것도 보내지 않습니다", action: null, canOpenSettings: false,
    });
  });
  it("네트워크 실패는 다시 시도 단추, 8050과 그 밖의 실패는 시스템 설정으로 이끈다", () => {
    expect(beforeConnect(link({ state: "failed", problem: "network" }))).toMatchObject({ action: { kind: "retry" }, canOpenSettings: false });
    expect(beforeConnect(link({ state: "failed", problem: "authBlocked8050" }))).toMatchObject({ action: null, canOpenSettings: true });
    expect(beforeConnect(link({ state: "failed", problem: "keyNeedsCheck" }))).toMatchObject({ action: null, canOpenSettings: true });
  });
});
