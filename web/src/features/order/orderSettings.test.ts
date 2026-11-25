import { describe, expect, it } from "vitest";
import { DEFAULT_ORDER_SETTINGS, MAX_PRESET_AMOUNT_MAN, parseOrderSettings, withAmountPreset } from "./orderSettings";

describe("호가주문 설정", () => {
  it("없거나 깨진 값은 기본값이다", () => {
    expect(parseOrderSettings(undefined)).toBe(DEFAULT_ORDER_SETTINGS);
    expect(parseOrderSettings({ amountPresets: [1, 2, 3] }).amountPresets).toEqual(DEFAULT_ORDER_SETTINGS.amountPresets);
    expect(parseOrderSettings({ rate: "yes" }).rate).toBe(true);
  });

  it("저장된 값을 읽는다", () => {
    expect(parseOrderSettings({ amountPresets: [5, 6, 7, 8], averageDot: false, divider: false, rate: false, skipSpreadGap: true, maskAccount: false, keepLastEntry: false, sound: false, venue: "nxt", account: "ref-b" })).toEqual({ amountPresets: [5, 6, 7, 8], averageDot: false, divider: false, rate: false, skipSpreadGap: true, maskAccount: false, keepLastEntry: false, sound: false, venue: "nxt", account: "ref-b" });
  });

  it("호가 사이 빈 가격 건너뛰기는 기본이 꺼짐이고 옛 저장값에 없거나 불이 아니면 꺼짐이며 있으면 그 값이다", () => {
    expect(DEFAULT_ORDER_SETTINGS.skipSpreadGap).toBe(false);
    expect(parseOrderSettings({ amountPresets: [1, 2, 3, 4] }).skipSpreadGap).toBe(false);
    expect(parseOrderSettings({ skipSpreadGap: "yes" }).skipSpreadGap).toBe(false);
    expect(parseOrderSettings({ skipSpreadGap: 1 }).skipSpreadGap).toBe(false);
    expect(parseOrderSettings({ skipSpreadGap: true }).skipSpreadGap).toBe(true);
    expect(parseOrderSettings({ skipSpreadGap: false }).skipSpreadGap).toBe(false);
  });

  it("마지막 주문 수량 유지는 기본이 켜짐이고 옛 저장값에 없거나 깨졌으면 켜짐이며 있으면 그 값이다", () => {
    expect(DEFAULT_ORDER_SETTINGS.keepLastEntry).toBe(true);
    expect(parseOrderSettings({ amountPresets: [1, 2, 3, 4] }).keepLastEntry).toBe(true);
    expect(parseOrderSettings({ keepLastEntry: "no" }).keepLastEntry).toBe(true);
    expect(parseOrderSettings({ keepLastEntry: 0 }).keepLastEntry).toBe(true);
    expect(parseOrderSettings({ keepLastEntry: false }).keepLastEntry).toBe(false);
    expect(parseOrderSettings({ keepLastEntry: true }).keepLastEntry).toBe(true);
  });

  it("계좌번호 가리기는 기본이 켜짐이고 옛 저장값에 없거나 깨졌으면 켜짐이다", () => {
    expect(DEFAULT_ORDER_SETTINGS.maskAccount).toBe(true);
    expect(parseOrderSettings({ amountPresets: [1, 2, 3, 4] }).maskAccount).toBe(true);
    expect(parseOrderSettings({ maskAccount: "no" }).maskAccount).toBe(true);
    expect(parseOrderSettings({ maskAccount: false }).maskAccount).toBe(false);
    expect(parseOrderSettings({ maskAccount: true }).maskAccount).toBe(true);
  });

  it("주문 소리는 기본이 켜짐이고 옛 저장값에 없거나 깨졌으면 켜짐이며 있으면 그 값이다", () => {
    expect(DEFAULT_ORDER_SETTINGS.sound).toBe(true);
    expect(parseOrderSettings({ amountPresets: [1, 2, 3, 4] }).sound).toBe(true);
    expect(parseOrderSettings({ sound: "no" }).sound).toBe(true);
    expect(parseOrderSettings({ sound: 0 }).sound).toBe(true);
    expect(parseOrderSettings({ sound: false }).sound).toBe(false);
    expect(parseOrderSettings({ sound: true }).sound).toBe(true);
  });

  it("주문 경로는 옛 값에 없거나 모르는 값이면 SOR이고 KRX·NXT는 그대로 읽는다", () => {
    expect(DEFAULT_ORDER_SETTINGS.venue).toBe("combined");
    expect(parseOrderSettings({ amountPresets: [1, 2, 3, 4] }).venue).toBe("combined");
    expect(parseOrderSettings({ venue: "bogus" }).venue).toBe("combined");
    expect(parseOrderSettings({ venue: 3 }).venue).toBe("combined");
    expect(parseOrderSettings({ venue: "combined" }).venue).toBe("combined");
    expect(parseOrderSettings({ venue: "krx" }).venue).toBe("krx");
    expect(parseOrderSettings({ venue: "nxt" }).venue).toBe("nxt");
  });

  it("금액 프리셋이 없거나 깨지면 기본값이고 올바르면 그대로 읽는다", () => {
    expect(DEFAULT_ORDER_SETTINGS.amountPresets).toEqual([100, 500, 1_000, 5_000]);
    expect(parseOrderSettings({}).amountPresets).toEqual([100, 500, 1_000, 5_000]);
    expect(parseOrderSettings({ amountPresets: [1, 2, 3] }).amountPresets).toEqual([100, 500, 1_000, 5_000]);
    expect(parseOrderSettings({ amountPresets: [1, 0, 3, 4] }).amountPresets).toEqual([100, 500, 1_000, 5_000]);
    expect(parseOrderSettings({ amountPresets: [1, 2.5, 3, 4] }).amountPresets).toEqual([100, 500, 1_000, 5_000]);
    expect(parseOrderSettings({ amountPresets: [20, 30, 40, 50] }).amountPresets).toEqual([20, 30, 40, 50]);
  });

  it("금액 프리셋은 0, 빈 값, 소수, 상한 초과를 받지 않는다", () => {
    expect(withAmountPreset(DEFAULT_ORDER_SETTINGS, 1, "75").amountPresets).toEqual([100, 75, 1_000, 5_000]);
    for (const text of ["0", "", " ", "1.5", String(MAX_PRESET_AMOUNT_MAN + 1), "-3", "abc"]) expect(withAmountPreset(DEFAULT_ORDER_SETTINGS, 0, text)).toBe(DEFAULT_ORDER_SETTINGS);
    expect(withAmountPreset(DEFAULT_ORDER_SETTINGS, 0, String(MAX_PRESET_AMOUNT_MAN)).amountPresets[0]).toBe(MAX_PRESET_AMOUNT_MAN);
  });

  it("고른 계좌는 기본이 없음이고 문자열이 아니거나 비었으면 없음이다", () => {
    expect(DEFAULT_ORDER_SETTINGS.account).toBeNull();
    expect(parseOrderSettings({ account: 3 }).account).toBeNull();
    expect(parseOrderSettings({ account: "" }).account).toBeNull();
    expect(parseOrderSettings({ account: "ref-b" }).account).toBe("ref-b");
  });
});
