import { describe, expect, it } from "vitest";
import type { KiwoomLinkStatus } from "../../api/generated/KiwoomLinkStatus";
import { canSaveKey, connectBlockReason, EMPTY_KEY_FORM, formatRemaining, ipDiffers, keyFormReducer, keyLocked, keySaveNote, maskedAppKey, NO_CONFIRMATIONS, panelView } from "./kiwoomPanel";

const base: KiwoomLinkStatus = {
  environment: "real", keySource: "file", appKeyTail: "7Q2D", credentialId: null, state: "disconnected", problem: null, message: "", retryAt: null, needsAcknowledgement: false,
  step: null, tokenExpiresAt: null, realtimeRegistered: null, symbolCount: null, registeredIp: null, atStart: "connects",
};
const failed = (problem: NonNullable<KiwoomLinkStatus["problem"]>, retryAt: number | null = null, patch: Partial<KiwoomLinkStatus> = {}): KiwoomLinkStatus => ({ ...base, state: "failed", problem, retryAt, ...patch });
const both = { registeredIp: true, lockChecked: true };

describe("상태별 행동", () => {
  it("키 없음은 연결 단추가 없다", () => {
    expect(panelView({ ...base, state: "noKey", keySource: "none" }, 0)).toMatchObject({ stage: "noKey", connect: null });
  });
  it("연결 안 함은 바로 연결할 수 있다", () => {
    expect(panelView(base, 0).connect).toMatchObject({ label: "키움에 연결", enabled: true, acknowledged: false });
  });
  it("연결 중에는 어떤 단추도 없다(취소 없음)", () => {
    expect(panelView({ ...base, state: "connecting", step: "token" }, 0)).toMatchObject({ stage: "connecting", connect: null, disconnect: false });
  });
  it("연결됨은 끊기만 있다", () => {
    expect(panelView({ ...base, state: "connected" }, 0)).toMatchObject({ stage: "connected", connect: null, disconnect: true });
  });
  it("키 확인 필요는 연결 단추 없이 키 바꾸기만 남긴다", () => {
    expect(panelView(failed("keyNeedsCheck"), 0)).toMatchObject({ stage: "keyNeedsCheck", connect: null });
  });
  it("토큰 파일 사용 불가는 파일 다시 확인만 있다", () => {
    expect(panelView(failed("tokenFileUnusable"), 0)).toMatchObject({ recheckTokenFile: true, connect: null });
  });
  it("경로 멈춤은 단추가 없다", () => {
    expect(panelView(failed("pathStopped"), 0)).toMatchObject({ stage: "pathStopped", connect: null, recheckTokenFile: false });
  });
  it("네트워크 오류는 간격이 없으면 바로 다시 시도한다", () => {
    expect(panelView(failed("network"), 0).connect).toMatchObject({ label: "다시 시도", enabled: true });
  });
});

describe("대기 카운트다운은 서버 시계를 따른다", () => {
  const status = failed("issueIntervalWait", 1000);
  it("남은 시간 동안 단추가 꺼져 있고 글자에 남은 시간이 있다", () => {
    const view = panelView(status, 1000 - 582);
    expect(view.countdown?.remainingSeconds).toBe(582);
    expect(view.connect).toEqual({ label: "다시 연결 (9:42 뒤 가능)", enabled: false, acknowledged: false, readyNotice: false });
  });
  it("0이 되면 단추가 켜지고 지금 연결할 수 있다고 알린다", () => {
    expect(panelView(status, 1000).connect).toEqual({ label: "다시 연결", enabled: true, acknowledged: false, readyNotice: true });
    expect(panelView(status, 1500).countdown?.remainingSeconds).toBe(0);
  });
  it("지금 값이 바뀌면 남은 시간도 바뀐다", () => {
    expect(panelView(status, 400).countdown?.remainingSeconds).toBe(600);
    expect(panelView(status, 700).countdown?.remainingSeconds).toBe(300);
    expect(panelView(status, 700).countdown?.progress).toBeCloseTo(0.5);
  });
  it("인증 불확실도 같다", () => {
    expect(panelView(failed("authUncertain", 1000), 900).connect?.enabled).toBe(false);
    expect(panelView(failed("authUncertain", 1000), 1000).connect?.enabled).toBe(true);
  });
  it("분:초 형식", () => {
    expect(formatRemaining(582)).toBe("9:42");
    expect(formatRemaining(5)).toBe("0:05");
  });
});

describe("인증 차단 8050", () => {
  const blocked = failed("authBlocked8050", 1000);
  it("체크 하나로는 꺼져 있다", () => {
    expect(panelView(blocked, 1000, { registeredIp: true, lockChecked: false }).connect?.enabled).toBe(false);
    expect(panelView(blocked, 1000, { registeredIp: false, lockChecked: true }).connect?.enabled).toBe(false);
  });
  it("둘 다 체크해도 간격 전이면 꺼져 있다", () => {
    expect(panelView(blocked, 900, both).connect?.enabled).toBe(false);
  });
  it("둘 다 체크하고 간격이 지나면 켜지고 acknowledged를 보낸다", () => {
    expect(panelView(blocked, 1000, both).connect).toMatchObject({ enabled: true, acknowledged: true });
  });
  it("확인 칸과 IP 도움 자동 펼침을 요구한다", () => {
    expect(panelView(blocked, 0, NO_CONFIRMATIONS)).toMatchObject({ needsConfirmations: true, ipHelpOpensByItself: true });
    expect(panelView(failed("issueIntervalWait", 5), 0)).toMatchObject({ needsConfirmations: false, ipHelpOpensByItself: false });
  });
  it("확인 뒤 간격 안에서 받은 대기도 확인을 다시 요구하고 acknowledged로 보낸다", () => {
    const waiting = failed("issueIntervalWait", 1000, { needsAcknowledgement: true });
    expect(panelView(waiting, 900, both).connect).toMatchObject({ enabled: false, acknowledged: true });
    expect(panelView(waiting, 1000, NO_CONFIRMATIONS).connect).toMatchObject({ enabled: false, acknowledged: true });
    expect(panelView(waiting, 1000, both).connect).toMatchObject({ enabled: true, acknowledged: true });
    expect(panelView(waiting, 1000, both)).toMatchObject({ stage: "wait", needsConfirmations: true, ipHelpOpensByItself: true });
  });
  it("확인이 필요 없는 대기는 acknowledged false로 보낸다", () => {
    expect(panelView(failed("issueIntervalWait", 1000), 1000).connect).toMatchObject({ enabled: true, acknowledged: false });
  });
  it("간격 정보가 없으면 체크만으로 켜진다", () => {
    expect(panelView(failed("authBlocked8050"), 0, both).connect?.enabled).toBe(true);
  });
});

describe("꺼진 연결 단추의 이유", () => {
  const blocked = failed("authBlocked8050", 1000);
  it("확인이 모자라면 확인을 말한다", () => {
    expect(connectBlockReason(panelView(blocked, 500), NO_CONFIRMATIONS)).toBe("위 확인 두 칸을 모두 체크하면 켜집니다");
  });
  it("확인을 마치면 간격이 지나기를 기다린다고 말한다", () => {
    expect(connectBlockReason(panelView(blocked, 500, both), both)).toBe("발급 간격이 지나면 누를 수 있습니다");
  });
  it("누를 수 있거나 단추가 없으면 이유가 없다", () => {
    expect(connectBlockReason(panelView(blocked, 1000, both), both)).toBeNull();
    expect(connectBlockReason(panelView({ ...base, state: "noKey", keySource: "none" }, 0), NO_CONFIRMATIONS)).toBeNull();
  });
});

describe("키 폼", () => {
  it("저장이 끝나면 입력 값이 모두 비어 있다", () => {
    let form = keyFormReducer(EMPTY_KEY_FORM, { type: "edit" });
    form = keyFormReducer(form, { type: "appKey", value: "AAAA-APPKEY-7Q2D" });
    form = keyFormReducer(form, { type: "appSecret", value: "SECRET-VALUE" });
    expect(canSaveKey(form)).toBe(true);
    expect(keyFormReducer(form, { type: "saved" })).toEqual(EMPTY_KEY_FORM);
  });
  it("취소해도 입력 값이 남지 않는다", () => {
    const form = keyFormReducer(keyFormReducer(EMPTY_KEY_FORM, { type: "edit" }), { type: "appSecret", value: "s" });
    expect(keyFormReducer(form, { type: "cancel" })).toEqual(EMPTY_KEY_FORM);
  });
  it("바꾸기를 열면 이전 입력 없이 시작한다", () => {
    expect(keyFormReducer({ ...EMPTY_KEY_FORM, appKey: "x" }, { type: "edit" })).toEqual({ ...EMPTY_KEY_FORM, editing: true });
  });
  it("두 칸이 모두 차야 저장할 수 있다", () => {
    expect(canSaveKey({ ...EMPTY_KEY_FORM, appKey: "a" })).toBe(false);
    expect(canSaveKey({ ...EMPTY_KEY_FORM, appKey: " ", appSecret: "b" })).toBe(false);
  });
  it("환경 키와 연결 중에는 폼이 잠긴다", () => {
    expect(keyLocked({ ...base, keySource: "env" })).toBe(true);
    expect(keyLocked({ ...base, state: "connecting" })).toBe(true);
    expect(keyLocked(base)).toBe(false);
  });
  it("저장된 앱키는 끝 4자리만 보인다", () => {
    expect(maskedAppKey("7Q2D")).toBe("••••••••••••7Q2D");
    expect(maskedAppKey(null)).toBe("••••••••••••");
  });
});

describe("등록한 IP 비교", () => {
  const registered = { ...base, registeredIp: { ip: "1.1.1.1", at: 1 } };
  it("다르면 경고한다", () => {
    expect(ipDiffers("2.2.2.2", registered)).toBe(true);
    expect(ipDiffers("1.1.1.1", registered)).toBe(false);
  });
  it("확인 전이거나 등록한 IP가 없으면 경고하지 않는다", () => {
    expect(ipDiffers(null, registered)).toBe(false);
    expect(ipDiffers("2.2.2.2", base)).toBe(false);
  });
});

describe("시작 때 연결 안내와 대기 단계", () => {
  it("연결 안 함은 시작 때 연결 값에 따라 안내가 다르다", () => {
    expect(panelView({ ...base, atStart: "connects" }, 0).startNote).toBe("키는 저장됨 · 연결하지 않았습니다");
    expect(panelView({ ...base, atStart: "keptDisconnected" }, 0).startNote).toBe("연결을 끊어 두었습니다. 연결하면 다음부터 서버를 켤 때 자동으로 연결합니다");
  });
  it("연결됨은 자동 연결과 끊기 설명을 둔다", () => {
    expect(panelView({ ...base, state: "connected" }, 0)).toMatchObject({ startNote: "서버를 다시 켜도 자동으로 연결합니다", disconnectNote: "끊으면 다음에 서버를 켤 때도 연결하지 않습니다" });
  });
  it("8050은 재시작해도 풀리지 않는다고 알린다", () => {
    expect(panelView(failed("authBlocked8050", null), 0).startNote).toBe("서버를 다시 켜도 차단은 풀리지 않고 자동 연결도 하지 않습니다");
  });
  it("연결 중 대기 단계는 남은 시간과 끊기가 있고 연결 단추는 없다", () => {
    const view = panelView({ ...base, state: "connecting", step: "issueInterval", retryAt: 1000 }, 940);
    expect(view).toMatchObject({ stage: "connectingWait", connect: null, disconnect: true });
    expect(view.countdown?.remainingSeconds).toBe(60);
  });
  it("대기 단계가 아닌 연결 중은 끊기가 없다", () => {
    expect(panelView({ ...base, state: "connecting", step: "symbols" }, 0)).toMatchObject({ stage: "connecting", disconnect: false });
  });
});

describe("키 저장 안내", () => {
  it("저장하면 바로 연결한다고 알린다", () => {
    expect(keySaveNote(base)).toBe("connectsAtOnce");
    expect(keySaveNote({ ...base, state: "noKey", keySource: "none" })).toBe("connectsAtOnce");
  });
  it("8050 차단 중이면 확인 전에는 연결하지 않는다고 알린다", () => {
    expect(keySaveNote(failed("authBlocked8050"))).toBe("blockedBy8050");
  });
  it("환경 키는 저장할 수 없으니 안내가 없다", () => {
    expect(keySaveNote({ ...base, keySource: "env" })).toBeNull();
    expect(keySaveNote(null)).toBeNull();
  });
});
