import { expect, test } from "vitest";
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

test.each<[string, Connection, number, ReturnType<typeof connectionView>]>([
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
  expect(connectionView(c, now)).toEqual(expected);
});

const link = (patch: Partial<KiwoomLinkStatus>): KiwoomLinkStatus => ({
  keySource: "file", appKeyTail: "1234", credentialId: null, state: "connected", problem: null, message: "서버 문장", retryAt: null, needsAcknowledgement: false,
  step: null, tokenExpiresAt: null, realtimeRegistered: null, symbolCount: null, registeredIp: null, ...patch,
});

test.each<[string, Partial<KiwoomLinkStatus>, ReturnType<typeof connectionView>]>([
  ["키 없음", { state: "noKey" }, { tone: "gray", pulse: false, text: "키움 키가 없습니다: 시스템 설정에서 넣으세요" }],
  ["연결 안 함", { state: "disconnected" }, { tone: "gray", pulse: false, text: "키움에 연결하지 않았습니다" }],
  ["연결 중", { state: "connecting" }, { tone: "amber", pulse: false, text: "키움에 연결하는 중" }],
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
  expect(connectionView(open({}), MON_1000, link(patch))).toEqual(expected);
});

test("연결 상태가 연결됨이면 재연결·끊긴 구간 문장을 그대로 쓴다", () => {
  expect(connectionView(open({ backfilling: true }), MON_1000, link({ state: "connected" }))).toEqual({ tone: "amber", pulse: false, text: "끊긴 구간 메우는 중" });
});

test("서버 소켓이 닫혔으면 연결 상태보다 서버 재연결 문장이 먼저다", () => {
  expect(connectionView({ socket: "closed" }, MON_1000, link({ state: "noKey" })).text).toBe("서버에 다시 연결하는 중");
});
