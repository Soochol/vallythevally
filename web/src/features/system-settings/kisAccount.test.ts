import { describe, expect, it } from "vitest";
import type { KisAccountListing } from "../../api/generated/KisAccountListing";
import { accountCheckLine, digitsOnly, isTailInput, kisAccountText, kisCanEnableOrders, kisMissingHtsId } from "./kisAccount";

const listing = (patch: Partial<KisAccountListing> = {}): KisAccountListing => ({ accountTail: "56", accountMasked: "****-**56", htsIdSet: true, source: "file", ...patch });

describe("한투 계좌 줄", () => {
  it("계좌번호는 끝 2자리만 보이고 없으면 없음이다", () => {
    expect(kisAccountText(listing())).toBe("****-**56");
    expect(kisAccountText(listing({ accountTail: null, accountMasked: null }))).toBe("계좌번호 없음");
    expect(kisAccountText(null)).toBe("계좌번호 없음");
  });
  it("계좌번호가 있어야 주문 사용을 켤 수 있다", () => {
    expect(kisCanEnableOrders(listing())).toBe(true);
    expect(kisCanEnableOrders(listing({ accountTail: null }))).toBe(false);
    expect(kisCanEnableOrders(null)).toBe(false);
  });
  it("HTS ID가 없을 때만 체결 알림 안내 대상이다", () => {
    expect(kisMissingHtsId(listing({ htsIdSet: false }))).toBe(true);
    expect(kisMissingHtsId(listing())).toBe(false);
    expect(kisMissingHtsId(null)).toBe(false);
  });
});

describe("끝 2자리 입력", () => {
  it("숫자만 두 자리까지 받는다", () => {
    expect(digitsOnly("3a4b5")).toBe("34");
    expect(isTailInput("34")).toBe(true);
    expect(isTailInput("3")).toBe(false);
    expect(isTailInput("3a")).toBe(false);
  });
});

describe("더하기 3단계의 계좌 확인 줄", () => {
  it("성공하면 끝 2자리를 가린 계좌와 함께 잔고 조회가 됐다고 말하고 실패는 서버 사유 그대로다", () => {
    expect(accountCheckLine({ state: "ok", tail: "56" })).toEqual({ tone: "ok", text: "계좌 ****-**56 잔고 조회가 됐습니다" });
    expect(accountCheckLine({ state: "failed", message: "한투가 거절했습니다" })).toEqual({ tone: "error", text: "한투가 거절했습니다" });
    expect(accountCheckLine({ state: "checking" }).tone).toBe("wait");
  });
});
