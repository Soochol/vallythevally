import type { AccountProvider } from "../api/generated/AccountProvider";
import type { AccountStatus } from "../api/generated/AccountStatus";
import type { SyncStatus } from "../api/generated/SyncStatus";
import { ApiRequestError } from "../api/http";

export const SESSION_PATH = "/v1/session";
export const LOGOUT_PATH = "/v1/session/logout";
export const ACCOUNT_PATH = "/v1/account";

export const loginStartPath = (provider: AccountProvider): string => `/v1/session/${provider}/start`;

const NO_SYNC: SyncStatus = { state: "running", lastSuccessAt: null, pendingDocuments: 0, refusedDocuments: 0, lastError: null };

const isProvider = (value: unknown): value is AccountProvider => value === "google" || value === "naver";

export function statusOfSession(body: unknown): AccountStatus | null {
  if (typeof body !== "object" || body === null) return null;
  const { provider, createdAt } = body as { provider?: unknown; createdAt?: unknown };
  if (!isProvider(provider) || typeof createdAt !== "number" || !Number.isFinite(createdAt)) return null;
  return { state: "signed_in", provider, accountId: "", signedInAt: createdAt, sync: NO_SYNC };
}

export async function readSession(fetcher: typeof fetch = fetch): Promise<AccountStatus> {
  const res = await fetcher(SESSION_PATH, { method: "GET", headers: { Accept: "application/json" } });
  if (res.status === 401) return { state: "signed_out" };
  if (!res.ok) throw new ApiRequestError("internal", `로그인 상태를 읽지 못했습니다 (HTTP ${res.status})`);
  const status = statusOfSession(await res.json());
  if (status === null) throw new ApiRequestError("internal", "로그인 상태 응답이 올바르지 않습니다");
  return status;
}
