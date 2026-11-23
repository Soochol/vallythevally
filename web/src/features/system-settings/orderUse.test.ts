import { describe, expect, it } from "vitest";
import type { OrdersAccount } from "../../api/generated/OrdersAccount";
import type { OrdersStatus } from "../../api/generated/OrdersStatus";
import { accountNumberOf, canConfirmEnable, enableTail, enableWarning, mergeOrdersStatus, orderCanTurnOff, orderCanTurnOn, orderInUse, orderMarkOf, orderStateSentence } from "./orderUse";

const row = (patch: Partial<OrdersAccount> = {}): OrdersAccount => ({ keyId: "k", broker: "kiwoom", alias: "k", market: false, state: "on", accountRef: "r", accountTail: "12", ...patch });
const status = (patch: Partial<OrdersStatus> = {}): OrdersStatus => ({ state: "on", accountRef: "ref-a", accountTail: "01", message: "켜짐", accounts: [row({ keyId: "a", market: true })], ...patch });

describe("계좌 줄의 주문 사용 표시", () => {
  it("계좌번호는 끝 2자리만이고 모르면 켤 때 확인이다", () => {
    expect(accountNumberOf("12")).toBe("****-**12");
    expect(accountNumberOf(null)).toBe("켤 때 확인");
  });
  it("주문 표시는 켜짐·꺼짐·계좌 바뀜이다", () => {
    expect(orderMarkOf("on").text).toBe("주문 켜짐");
    expect(orderMarkOf("off").text).toBe("주문 꺼짐");
    expect(orderMarkOf("file_unusable").text).toBe("주문 꺼짐");
    expect(orderMarkOf("account_changed")).toEqual({ text: "계좌 바뀜", tone: "warn" });
  });
  it("계좌 바뀜이면 켜기와 끄기가 둘 다 보인다", () => {
    expect([orderCanTurnOn("off"), orderCanTurnOff("off")]).toEqual([true, false]);
    expect([orderCanTurnOn("on"), orderCanTurnOff("on")]).toEqual([false, true]);
    expect([orderCanTurnOn("account_changed"), orderCanTurnOff("account_changed")]).toEqual([true, true]);
    expect(orderCanTurnOn("file_unusable")).toBe(false);
  });
  it("지우기 문구를 덧붙일 사용 중 여부는 켜짐과 계좌 바뀜이다", () => {
    expect(orderInUse(row({ state: "on" }))).toBe(true);
    expect(orderInUse(row({ state: "account_changed" }))).toBe(true);
    expect(orderInUse(row({ state: "off" }))).toBe(false);
    expect(orderInUse(undefined)).toBe(false);
  });
});

describe("주문 사용 응답을 저장된 상태에 합치기", () => {
  it("시세 키 응답은 위쪽 상태까지 바꾼다", () => {
    const result = status({ state: "off" });
    expect(mergeOrdersStatus(status(), result, true)).toBe(result);
  });
  it("다른 키 응답은 목록만 바꾸고 시세 키 위쪽 상태를 지킨다", () => {
    const old = status();
    const result = status({ state: "on", accountRef: "ref-b", accountTail: "05", accounts: [row({ keyId: "a", market: true }), row({ keyId: "b" })] });
    const merged = mergeOrdersStatus(old, result, false);
    expect(merged.accountRef).toBe("ref-a");
    expect(merged.accounts).toBe(result.accounts);
  });
  it("저장된 상태가 없으면 응답을 그대로 둔다", () => {
    const result = status();
    expect(mergeOrdersStatus(undefined, result, false)).toBe(result);
  });
});

describe("주문 사용 켜기의 끝 2자리", () => {
  it("키움은 서버가 알려 준 끝 2자리를 싣고 한투는 사용자가 넣은 두 자리 숫자를 싣는다", () => {
    expect(enableTail("kiwoom", "12", "")).toBe("12");
    expect(enableTail("kis", "12", "34")).toBe("34");
    expect(enableTail("kis", "12", "3")).toBeNull();
    expect(enableTail("kis", "12", "3a")).toBeNull();
  });
  it("키움은 확인 상자를, 한투는 두 자리 입력을 마쳐야 켤 수 있다", () => {
    expect([canConfirmEnable("kiwoom", false, ""), canConfirmEnable("kiwoom", true, "")]).toEqual([false, true]);
    expect([canConfirmEnable("kis", true, ""), canConfirmEnable("kis", false, "34")]).toEqual([false, true]);
  });
});

describe("주문 사용 문장", () => {
  it("켜짐은 실제 체결을, 꺼짐은 주문이 나가지 않음을 말한다", () => {
    expect(orderStateSentence("on", false)).toContain("실제 체결");
    expect(orderStateSentence("off", false)).toBe("꺼짐 · 이 계좌로 주문이 나가지 않습니다");
  });
  it("모의투자는 실제 체결이라는 말을 쓰지 않는다", () => {
    expect(orderStateSentence("on", true)).not.toContain("실제 체결");
    expect(enableWarning(true)).toContain("실제 체결은 아닙니다");
    expect(enableWarning(false)).toBe("켜면 호가주문 창에서 누른 주문이 이 계좌로 실제 체결됩니다");
  });
});
