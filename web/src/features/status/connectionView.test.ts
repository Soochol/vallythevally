import { describe, expect, test } from "vitest";
import type { ConnectionStatus } from "../../api/generated/ConnectionStatus";
import type { Connection } from "../../api/socket";
import type { KiwoomLinkStatus } from "../../api/generated/KiwoomLinkStatus";
import { connectionView } from "./connectionView";

const kst = (iso: string) => Date.parse(`${iso}+09:00`) / 1000;
const MON_1000 = kst("2026-11-09T10:00:00");
const open = (status: Partial<ConnectionStatus>): Connection => ({
  socket: "open",
  status: { realtime: "live", since: kst("2026-11-09T14:02:00"), backfilling: false, ...status },
});

test.each<[string, Connection, number, Omit<ReturnType<typeof connectionView>, "action">]>([
  ["연결 중", { socket: "connecting" }, MON_1000, { tone: "gray", pulse: false, text: "서버에 다시 연결하는 중" }],
  ["끊김", { socket: "closed" }, MON_1000, { tone: "gray", pulse: false, text: "서버에 다시 연결하는 중" }],
  ["live, 장중", open({}), MON_1000, { tone: "mint", pulse: true, text: "실시간 연결됨" }],
  ["live, 08:00 정각은 장중", open({}), kst("2026-11-09T08:00:00"), { tone: "mint", pulse: true, text: "실시간 연결됨" }],
  ["live, 20:00은 장 닫힘", open({}), kst("2026-11-09T20:00:00"), { tone: "mint", pulse: false, text: "장 닫힘: 체결 없음" }],
  ["live, 07:59는 장 닫힘", open({}), kst("2026-11-09T07:59:00"), { tone: "mint", pulse: false, text: "장 닫힘: 체결 없음" }],
  ["live, 토요일", open({}), kst("2026-11-07T10:00:00"), { tone: "mint", pulse: false, text: "장 닫힘: 체결 없음" }],
  ["live, 일요일", open({}), kst("2026-11-08T10:00:00"), { tone: "mint", pulse: false, text: "장 닫힘: 체결 없음" }],
  [
    "reconnecting은 since를 보인다",
    open({ realtime: "reconnecting" }),
    MON_1000,
    { tone: "amber", pulse: false, text: "키움에 다시 연결하는 중 (14:02부터)" },
  ],
  ["backfilling", open({ backfilling: true }), MON_1000, { tone: "amber", pulse: false, text: "끊긴 구간 메우는 중" }],
  [
    "reconnecting이 backfilling보다 먼저",
    open({ realtime: "reconnecting", backfilling: true }),
    MON_1000,
    { tone: "amber", pulse: false, text: "키움에 다시 연결하는 중 (14:02부터)" },
  ],
  ["연결 안 함은 회색", open({ realtime: "notConnected" }), MON_1000, { tone: "gray", pulse: false, text: "키움에 연결하지 않았습니다" }],
  ["halted", open({ realtime: "halted", backfilling: true }), MON_1000, { tone: "red", pulse: false, text: "실시간 멈춤: 서버를 다시 켜야 합니다" }],
])("%s", (_name, c, now, expected) => {
  expect(connectionView(c, now)).toEqual({ ...expected, action: null });
});

const link = (patch: Partial<KiwoomLinkStatus>): KiwoomLinkStatus => ({
  environment: "real", keySource: "file", appKeyTail: "1234", credentialId: null, state: "connected", problem: null, message: "서버 문장", retryAt: null, needsAcknowledgement: false,
  step: null, tokenExpiresAt: null, realtimeRegistered: null, symbolCount: null, registeredIp: null, atStart: "connects", ...patch,
});

test.each<[string, Partial<KiwoomLinkStatus>, Omit<ReturnType<typeof connectionView>, "action">]>([
  ["키 없음", { state: "noKey" }, { tone: "gray", pulse: false, text: "키움 키가 없습니다: 시스템 설정에서 넣으세요" }],
  ["연결 안 함, 시작 때 연결", { state: "disconnected", atStart: "connects" }, { tone: "gray", pulse: false, text: "키는 저장됨 · 연결하지 않았습니다" }],
  ["연결 안 함, 끊어 둠", { state: "disconnected", atStart: "keptDisconnected" }, { tone: "gray", pulse: false, text: "연결을 끊어 두었습니다" }],
  ["연결 중", { state: "connecting" }, { tone: "amber", pulse: false, text: "키움에 연결하는 중" }],
  ["연결 중, 단계 이름", { state: "connecting", step: "token" }, { tone: "amber", pulse: false, text: "키움에 연결하는 중 · 토큰" }],
  ["연결 중, 대기 단계", { state: "connecting", step: "issueInterval", retryAt: MON_1000 + 432 }, { tone: "amber", pulse: false, text: "발급 간격 대기 · 7:12 뒤 저절로 연결" }],
  ["발급 간격 대기", { state: "failed", problem: "issueIntervalWait" }, { tone: "amber", pulse: false, text: "키움 토큰 발급 간격을 기다리는 중" }],
  ["인증 불확실", { state: "failed", problem: "authUncertain" }, { tone: "amber", pulse: false, text: "키움 인증을 확신할 수 없습니다: 시스템 설정에서 확인하세요" }],
  ["네트워크 오류", { state: "failed", problem: "network" }, { tone: "amber", pulse: false, text: "키움에 닿지 못했습니다: 네트워크를 확인하세요" }],
  ["인증 차단", { state: "failed", problem: "authBlocked8050" }, { tone: "red", pulse: false, text: "키움 인증 차단: 시스템 설정에서 확인하세요" }],
  ["키 확인 필요", { state: "failed", problem: "keyNeedsCheck" }, { tone: "red", pulse: false, text: "키움 키 확인 필요: 시스템 설정에서 확인하세요" }],
  ["토큰 파일 사용 불가", { state: "failed", problem: "tokenFileUnusable" }, { tone: "red", pulse: false, text: "토큰 파일을 쓸 수 없습니다: 시스템 설정에서 확인하세요" }],
  ["경로 멈춤", { state: "failed", problem: "pathStopped" }, { tone: "red", pulse: false, text: "실시간 멈춤: 서버를 다시 켜야 합니다" }],
  ["사유 없는 실패는 서버 문장", { state: "failed", problem: null }, { tone: "red", pulse: false, text: "서버 문장" }],
  ["연결됨은 실시간 문장 그대로", { state: "connected" }, { tone: "mint", pulse: true, text: "실시간 연결됨" }],
])("연결 상태 저장소: %s", (_name, patch, expected) => {
  expect(connectionView(open({}), MON_1000, link(patch))).toMatchObject(expected);
});

test("연결 상태가 연결됨이면 재연결·끊긴 구간 문장을 그대로 쓴다", () => {
  expect(connectionView(open({ backfilling: true }), MON_1000, link({ state: "connected" }))).toMatchObject({ tone: "amber", pulse: false, text: "끊긴 구간 메우는 중" });
});

test("서버 소켓이 닫혔으면 연결 상태보다 서버 재연결 문장이 먼저다", () => {
  expect(connectionView({ socket: "closed" }, MON_1000, link({ state: "noKey" })).text).toBe("서버에 다시 연결하는 중");
});

const actionOf = (patch: Partial<KiwoomLinkStatus>) => connectionView(open({}), MON_1000, link(patch)).action;

describe("상태 줄의 바로 연결 단추", () => {
  test.each<[string, Partial<KiwoomLinkStatus>]>([
    ["시작 때 연결", { state: "disconnected", atStart: "connects" }],
    ["끊어 둠", { state: "disconnected", atStart: "keptDisconnected" }],
  ])("연결 안 함(%s)은 연결 단추가 있다", (_name, patch) => {
    expect(actionOf(patch)).toEqual({ kind: "connect", label: "연결", enabled: true });
  });

  test("네트워크 실패는 간격이 지났으면 다시 시도, 안 지났으면 꺼진 남은 시간 단추다", () => {
    expect(actionOf({ state: "failed", problem: "network", retryAt: null })).toEqual({ kind: "retry", label: "다시 시도", enabled: true });
    expect(actionOf({ state: "failed", problem: "network", retryAt: MON_1000 - 1 })).toEqual({ kind: "retry", label: "다시 시도", enabled: true });
    expect(actionOf({ state: "failed", problem: "network", retryAt: MON_1000 + 65 })).toEqual({ kind: "retry", label: "1:05 뒤 다시 시도", enabled: false });
  });

  test.each<[string, Partial<KiwoomLinkStatus>]>([
    ["키 없음", { state: "noKey" }],
    ["연결 중", { state: "connecting", step: "token" }],
    ["대기 단계", { state: "connecting", step: "issueInterval", retryAt: MON_1000 + 60 }],
    ["8050", { state: "failed", problem: "authBlocked8050" }],
    ["확인이 필요한 네트워크 실패", { state: "failed", problem: "network", needsAcknowledgement: true }],
    ["키 확인 필요", { state: "failed", problem: "keyNeedsCheck" }],
    ["토큰 파일 사용 불가", { state: "failed", problem: "tokenFileUnusable" }],
    ["키 파일 사용 불가", { state: "failed", problem: "keyFileUnusable" }],
    ["연결됨", { state: "connected" }],
  ])("%s에는 단추가 없다", (_name, patch) => {
    expect(actionOf(patch)).toBeNull();
  });

  test("대기 단계의 남은 시간은 서버 시각을 따라 줄고 0이면 곧 연결한다고 말한다", () => {
    const waiting = link({ state: "connecting", step: "issueInterval", retryAt: MON_1000 + 600 });
    expect(connectionView(open({}), MON_1000 + 1, waiting).text).toBe("발급 간격 대기 · 9:59 뒤 저절로 연결");
    expect(connectionView(open({}), MON_1000 + 600, waiting).text).toBe("발급 간격 대기 · 곧 저절로 연결");
  });
});
