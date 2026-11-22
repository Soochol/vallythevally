import type { OrdersAccount } from "../../api/generated/OrdersAccount";
import type { OrdersState } from "../../api/generated/OrdersState";
import type { OrdersStatus } from "../../api/generated/OrdersStatus";

export const FALLBACK_NOTICE = "고른 계좌가 꺼져 시세 키 계좌로 돌아갑니다";
export const MANAGE_ACCOUNTS_TEXT = "시스템 설정에서 계좌 관리";
const BROKER = "키움";

export interface CurrentAccount {
  readonly keyId: string | null;
  readonly ref: string | null;
  readonly tail: string | null;
  readonly state: OrdersState;
  readonly message: string;
}

export interface OrderAccountChoice {
  readonly accounts: readonly OrdersAccount[];
  readonly current: CurrentAccount | null;
  readonly fellBack: boolean;
}

export const isPickable = (account: OrdersAccount): boolean => account.state === "on" && account.accountRef !== null;

const currentOf = (account: OrdersAccount): CurrentAccount => ({ keyId: account.keyId, ref: account.accountRef, tail: account.accountTail, state: account.state, message: "" });

export function chooseAccount(status: OrdersStatus | undefined, saved: string | null): OrderAccountChoice {
  if (status === undefined) return { accounts: [], current: null, fellBack: false };
  const accounts = status.accounts;
  const picked = saved === null ? undefined : accounts.find((account) => account.accountRef === saved && isPickable(account));
  if (picked) return { accounts, current: currentOf(picked), fellBack: false };
  const market = accounts.find((account) => account.market);
  return { accounts, current: { keyId: market?.keyId ?? null, ref: status.accountRef, tail: status.accountTail, state: status.state, message: status.message }, fellBack: saved !== null };
}

export const canPick = (accounts: readonly OrdersAccount[]): boolean => accounts.length > 1;

export const accountNumberText = (tail: string | null): string => (tail === null ? `${BROKER} —` : `${BROKER} ****-**${tail}`);

export const optionText = (account: OrdersAccount): string => `${account.alias} · ${account.accountTail === null ? "계좌 미확인" : accountNumberText(account.accountTail)}`;

export function optionNote(account: OrdersAccount): string | null {
  if (account.state === "account_changed") return "계좌 바뀜";
  if (account.state !== "on") return "주문 꺼짐";
  return account.market ? "시세" : null;
}

export const selectedKeyAlias = (choice: OrderAccountChoice): string | null => choice.accounts.find((account) => account.keyId === choice.current?.keyId)?.alias ?? null;
