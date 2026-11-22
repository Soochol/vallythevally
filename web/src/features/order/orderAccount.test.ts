import { describe, expect, it } from "vitest";
import type { OrdersAccount } from "../../api/generated/OrdersAccount";
import type { OrdersStatus } from "../../api/generated/OrdersStatus";
import { accountNumberText, canPick, chooseAccount, optionNote, optionText } from "./orderAccount";

const account = (keyId: string, patch: Partial<OrdersAccount> = {}): OrdersAccount => ({ keyId, alias: keyId, market: false, state: "on", accountRef: `ref-${keyId}`, accountTail: "12", ...patch });
const status = (accounts: OrdersAccount[], patch: Partial<OrdersStatus> = {}): OrdersStatus => ({ state: "on", accountRef: "ref-a", accountTail: "01", message: "", accounts, ...patch });
const accounts = [account("a", { market: true, accountTail: "01" }), account("b", { accountTail: "05" }), account("c", { state: "off", accountTail: null, accountRef: null })];

describe("호가주문창이 쓸 계좌 고르기", () => {
  it("고른 계좌가 없으면 시세 키 계좌다", () => {
    const choice = chooseAccount(status(accounts), null);
    expect(choice.current?.ref).toBe("ref-a");
    expect(choice.current?.keyId).toBe("a");
    expect(choice.fellBack).toBe(false);
  });
  it("주문이 켜진 고른 계좌를 그대로 쓴다", () => {
    const choice = chooseAccount(status(accounts), "ref-b");
    expect(choice.current).toMatchObject({ keyId: "b", ref: "ref-b", tail: "05", state: "on" });
    expect(choice.fellBack).toBe(false);
  });
  it("고른 계좌가 목록에 없으면 시세 키 계좌로 돌아가고 알린다", () => {
    const choice = chooseAccount(status(accounts), "ref-gone");
    expect(choice.current?.ref).toBe("ref-a");
    expect(choice.fellBack).toBe(true);
  });
  it("고른 계좌의 주문 사용이 꺼졌거나 계좌가 바뀌었으면 돌아간다", () => {
    expect(chooseAccount(status([accounts[0]!, account("b", { state: "off" })]), "ref-b").fellBack).toBe(true);
    expect(chooseAccount(status([accounts[0]!, account("b", { state: "account_changed" })]), "ref-b").fellBack).toBe(true);
  });
  it("상태를 받기 전에는 돌아가지 않는다", () => {
    expect(chooseAccount(undefined, "ref-b")).toEqual({ accounts: [], current: null, fellBack: false });
  });
  it("시세 키 계좌가 꺼져 있으면 위쪽 상태의 꺼짐과 문구를 그대로 쓴다", () => {
    const choice = chooseAccount(status(accounts, { state: "off", accountRef: null, accountTail: null, message: "주문 사용이 꺼져 있습니다" }), null);
    expect(choice.current).toMatchObject({ state: "off", ref: null, message: "주문 사용이 꺼져 있습니다" });
  });
  it("키가 둘 이상일 때만 고를 수 있다", () => {
    expect(canPick(accounts)).toBe(true);
    expect(canPick([accounts[0]!])).toBe(false);
    expect(canPick([])).toBe(false);
  });
});

describe("계좌 목록 글자", () => {
  it("끝 2자리만 보인다", () => {
    expect(accountNumberText("12")).toBe("키움 ****-**12");
    expect(accountNumberText(null)).toBe("키움 —");
    expect(optionText(account("b", { alias: "위탁 2", accountTail: "05" }))).toBe("위탁 2 · 키움 ****-**05");
    expect(optionText(account("c", { alias: "연금", accountTail: null }))).toBe("연금 · 계좌 미확인");
  });
  it("시세 키는 시세, 주문이 꺼진 계좌는 주문 꺼짐이다", () => {
    expect(optionNote(accounts[0]!)).toBe("시세");
    expect(optionNote(accounts[1]!)).toBeNull();
    expect(optionNote(accounts[2]!)).toBe("주문 꺼짐");
    expect(optionNote(account("d", { state: "account_changed" }))).toBe("계좌 바뀜");
  });
});
