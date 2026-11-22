import { describe, expect, it } from "vitest";
import type { KiwoomKey } from "../../api/generated/KiwoomKey";
import type { KiwoomLinkStatus } from "../../api/generated/KiwoomLinkStatus";
import { addedKey, addSteps, defaultAlias, editRequest, emptyEntry, marketChangeText, menuDotTone, removeText, shortReason } from "./kiwoomKeys";

const link = (patch: Partial<KiwoomLinkStatus> = {}): KiwoomLinkStatus => ({
  environment: "real", keySource: "file", appKeyTail: "1234", credentialId: null, state: "connected", problem: null, message: "", retryAt: null, needsAcknowledgement: false,
  step: null, tokenExpiresAt: null, realtimeRegistered: null, symbolCount: null, registeredIp: null, atStart: null, ...patch,
});
const key = (keyId: string, alias: string, patch: Partial<KiwoomKey> = {}): KiwoomKey => ({ keyId, alias, broker: "kiwoom", source: "file", appKeyTail: "1234", market: false, link: link(), ...patch });
const blocked = link({ state: "failed", problem: "authBlocked8050" });

describe("키 목록 화면의 판단", () => {
  it("메뉴 점은 시세 키 상태를 따르고 다른 키에 오류가 있으면 노랑이다", () => {
    const keys = [key("k1", "주계좌", { market: true }), key("k2", "보조", { link: blocked })];
    expect(menuDotTone(link(), keys)).toBe("amber");
    expect(menuDotTone(link(), [keys[0]!])).toBe("mint");
    expect(menuDotTone(blocked, keys)).toBe("red");
    expect(menuDotTone(link(), undefined)).toBe("mint");
  });
  it("지우기 문구는 시세 키일 때 다음 시세 키를 말한다", () => {
    const keys = [key("k1", "주계좌", { market: true }), key("k2", "보조")];
    expect(removeText(keys, keys[0]!)).toContain("‘보조’");
    expect(removeText(keys, keys[1]!)).not.toContain("시세");
    expect(removeText([keys[0]!], keys[0]!)).toContain("키가 없어");
  });
  it("주문 사용 중인 키를 지우면 호가주문창이 시세 공급원 계좌로 돌아간다고 더한다", () => {
    const keys = [key("k1", "주계좌", { market: true }), key("k2", "보조")];
    expect(removeText(keys, keys[1]!, true)).toBe("‘보조’ 키를 지웁니다. 주문 사용이 꺼지고, 이 계좌를 고른 호가주문창은 시세 공급원 계좌로 돌아갑니다");
    expect(removeText(keys, keys[1]!)).not.toContain("호가주문창");
    expect(removeText(keys, keys[0]!, true)).toContain("시세를 ‘보조’에서 받습니다. 주문 사용이 꺼지고");
  });
  it("시세 키 바꾸기 문구는 세 사실을 말한다", () => {
    const text = marketChangeText("보조");
    expect(text).toContain("시세를 ‘보조’에서 받습니다");
    expect(text).toContain("열린 차트·호가·체결을 새로 받습니다");
    expect(text).toContain("주문 계좌는 바뀌지 않습니다");
  });
  it("증권사가 하나면 증권사 단계를 건너뛴다", () => {
    expect(addSteps(["kiwoom"])).toEqual(["input", "confirm"]);
    expect(addSteps(["kiwoom", "kiwoom"])).toEqual(["broker", "input", "confirm"]);
  });
  it("기본 별칭은 그 증권사 키 수 + 1이다", () => {
    expect(defaultAlias([], "kiwoom")).toBe("키움 1");
    expect(defaultAlias([key("k1", "a"), key("k2", "b")], "kiwoom")).toBe("키움 3");
  });
  it("더한 키는 이전 목록에 없던 키다", () => {
    const before = [key("k1", "a")];
    expect(addedKey(before, [...before, key("k2", "b")])?.keyId).toBe("k2");
  });
  it("바꾸기 요청: 별칭만, 키만, 둘 다, 불완전", () => {
    const current = key("k1", "주계좌");
    expect(editRequest({ ...emptyEntry("새 이름"), }, current)).toEqual({ alias: "새 이름", credentials: null });
    expect(editRequest({ ...emptyEntry("주계좌"), appKey: " A ", appSecret: "S" }, current)).toEqual({ alias: null, credentials: { appKey: "A", appSecret: "S" } });
    expect(editRequest({ ...emptyEntry("새 이름"), appKey: "A", appSecret: "S" }, current)).toEqual({ alias: "새 이름", credentials: { appKey: "A", appSecret: "S" } });
    expect(editRequest({ ...emptyEntry("주계좌"), appKey: "A" }, current)).toBeNull();
    expect(editRequest(emptyEntry("주계좌"), current)).toBeNull();
    expect(editRequest(emptyEntry(" "), current)).toBeNull();
  });
  it("줄의 짧은 사유는 오류와 대기만 있다", () => {
    expect(shortReason(link(), 0)).toBeNull();
    expect(shortReason(blocked, 0)).toBe("8050 인증 차단");
    expect(shortReason(link({ state: "failed", problem: "issueIntervalWait", retryAt: 100 }), 40)).toBe("발급 간격 대기 1:00");
  });
});
