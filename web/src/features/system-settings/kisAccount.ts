import type { KisAccountListing } from "../../api/generated/KisAccountListing";
import type { KiwoomKey } from "../../api/generated/KiwoomKey";

export const ACCOUNT_SHAPE_HINT = "12345678-01";
export const ACCOUNT_NUMBER_HINT = `8자리-2자리 (${ACCOUNT_SHAPE_HINT} 모양). 한투 앱에서 이 앱키를 신청한 계좌`;
export const HTS_ID_PLACEHOLDER = "비워 두면 체결 알림 없음";
export const NO_ACCOUNT_TEXT = "계좌번호 없음";
export const NO_ACCOUNT_ORDER_NOTE = "계좌번호를 넣어야 주문 사용을 켤 수 있습니다";
export const NO_HTS_ID_NOTE = "HTS ID가 없어 체결 알림을 받지 못합니다. 주문 뒤 조회로 맞춥니다";
export const ENV_ACCOUNT_NOTE = ".env에서 읽음 · 읽기 전용. 바꾸려면 .env에서 해당 줄을 지우세요";

export const kisListingOf = (key: KiwoomKey): KisAccountListing | null => (key.broker === "kis" ? key.kisAccount : null);

export const kisAccountText = (listing: KisAccountListing | null): string => (listing?.accountTail ? `****-**${listing.accountTail}` : NO_ACCOUNT_TEXT);

export const kisCanEnableOrders = (listing: KisAccountListing | null): boolean => listing !== null && listing.accountTail !== null;

export const kisMissingHtsId = (listing: KisAccountListing | null): boolean => listing !== null && !listing.htsIdSet;

export const isTailInput = (text: string): boolean => /^\d{2}$/.test(text);

export const digitsOnly = (text: string): string => text.replace(/\D/g, "").slice(0, 2);

export type AccountCheck = { readonly state: "waiting" } | { readonly state: "checking" } | { readonly state: "ok"; readonly tail: string } | { readonly state: "failed"; readonly message: string };

export function accountCheckLine(check: AccountCheck): { readonly tone: "ok" | "wait" | "error"; readonly text: string } {
  switch (check.state) {
    case "waiting":
      return { tone: "wait", text: "연결을 기다린 뒤 계좌를 확인합니다" };
    case "checking":
      return { tone: "wait", text: "계좌를 확인하는 중입니다" };
    case "ok":
      return { tone: "ok", text: `계좌 ****-**${check.tail} 잔고 조회가 됐습니다` };
    case "failed":
      return { tone: "error", text: check.message };
  }
}
