import { describe, expect, it } from "vitest";
import type { KiwoomKey } from "../../api/generated/KiwoomKey";
import type { KiwoomLinkStatus } from "../../api/generated/KiwoomLinkStatus";
import type { MarketSourceStatus } from "../../api/generated/MarketSourceStatus";
import { addedKey, addSteps, brokersShown, defaultAlias, editRequest, emptyEntry, feedLine, marketChangeText, menuDotTone, removeText, shortReason } from "./kiwoomKeys";
import { panelView } from "./kiwoomPanel";

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

describe("한투", () => {
  const kis = (keyId: string, patch: Partial<KiwoomKey> = {}) => key(keyId, "한투 1", { broker: "kis", ...patch });
  const inUse = link({ state: "failed", problem: "network", message: "한투 실시간 접속을 다른 곳에서 쓰고 있어 끊었습니다(OPSP8996). 다른 프로그램의 한투 실시간 연결을 끈 뒤 다시 연결하세요" });
  const source = (feed: "kiwoom" | "kis" | null): MarketSourceStatus => ({ broker: "kis", keyId: "kis1", alias: "한투 1", state: "connected", problem: null, step: null, retryAt: null, features: [], feedBroker: feed && { broker: feed, rankingKinds: [], rankingChoices: [], overviewFeatures: [] } });

  it("증권사가 바뀔 때만 확인 문구에 한투 제약이 붙는다", () => {
    expect(marketChangeText("한투 1", "kiwoom", "kis")).toContain("한투는 분봉을 1분봉에서 만들고, 실시간은 40건까지입니다");
    expect(marketChangeText("한투 1", "kis", "kis")).not.toContain("분봉");
    expect(marketChangeText("주계좌", "kis", "kiwoom")).not.toContain("분봉");
    expect(marketChangeText("보조")).toBe("시세를 ‘보조’에서 받습니다. 열린 차트·호가·체결을 새로 받습니다. 주문 계좌는 바뀌지 않습니다");
  });
  it("OPSP8996은 한투 키일 때만 다른 프로그램 사용 중이고 단추는 다시 연결이다", () => {
    expect(shortReason(inUse, 0, "kis")).toBe("다른 프로그램이 사용 중");
    expect(shortReason(inUse, 0, "kiwoom")).toBe("키움에 닿지 못함");
    expect(panelView(inUse, 0, undefined, "kis")).toMatchObject({ stage: "inUseElsewhere", connect: { label: "다시 연결", enabled: true } });
    expect(panelView(inUse, 0, undefined, "kiwoom").stage).toBe("network");
  });
  it("계좌 목록은 키움 묶음을 늘 보이고 한투 묶음은 키가 있을 때만 보인다", () => {
    expect(brokersShown({ limit: 5, keys: [key("k1", "주계좌")], keyFileProblem: null })).toEqual(["kiwoom"]);
    expect(brokersShown({ limit: 5, keys: [key("k1", "주계좌"), kis("kis1")], keyFileProblem: null })).toEqual(["kiwoom", "kis"]);
    expect(brokersShown({ limit: 5, keys: [], keyFileProblem: null })).toEqual(["kiwoom"]);
  });
  it("받는 증권사 줄은 서버가 말한 증권사와 그 증권사의 연결된 첫 키를 보인다", () => {
    const keys = [key("k1", "주계좌"), kis("kis1", { market: true })];
    expect(feedLine(source("kiwoom"), keys)).toBe("순위·시장 개요·투자자: 키움 · ‘주계좌’");
    expect(feedLine(source("kis"), keys)).toBe("순위·시장 개요·투자자: 한투 · ‘한투 1’");
    expect(feedLine(source(null), keys)).toBe("순위·시장 개요·투자자: 받을 연결이 없습니다");
    expect(feedLine(null, keys)).toBeNull();
  });
  it("시세 키를 지울 때 다음 시세 키가 다른 증권사면 제약을 붙인다", () => {
    const keys = [key("k1", "주계좌", { market: true }), kis("kis1")];
    expect(removeText(keys, keys[0]!)).toContain("한투는 분봉을 1분봉에서 만들고");
  });
});
