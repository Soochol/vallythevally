import type { AccountProvider } from "../../api/generated/AccountProvider";

export const PROVIDER_NAME: Record<AccountProvider, string> = { google: "Google", naver: "네이버" };
export const shortAccountId = (id: string) => id.slice(0, 8);
