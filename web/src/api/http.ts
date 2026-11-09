import { useKiwoomStore } from "../stores/kiwoom";
import type { ApiErrorCode } from "./generated/ApiErrorCode";
import type { ApiErrorReason } from "./generated/ApiErrorReason";
import type { UnixSeconds } from "./generated/UnixSeconds";

const API_ERROR_CODES = [
  "bad_request",
  "not_found",
  "unknown_symbol",
  "kiwoom_unavailable",
  "kiwoom_auth_failed",
  "conflict",
  "payload_too_large",
  "stale_revision",
  "method_not_allowed",
  "internal",
] as const satisfies readonly ApiErrorCode[];

// 계약에 코드가 늘면 여기서 타입 오류가 난다.
const _allCodesListed: Exclude<ApiErrorCode, (typeof API_ERROR_CODES)[number]> extends never ? true : never = true;
void _allCodesListed;

const API_ERROR_REASONS = [
  "rate_limited",
  "kiwoom_unreachable",
  "kiwoom_timeout",
  "kiwoom_error",
  "token_invalid",
  "auth_blocked",
  "auth_indeterminate",
  "issue_interval",
  "token_file",
  "symbol_mismatch",
  "invalid_request",
  "unsupported",
  "unknown_failure",
  "protocol",
  "symbol_list_loading",
] as const satisfies readonly ApiErrorReason[];

const _allReasonsListed: Exclude<ApiErrorReason, (typeof API_ERROR_REASONS)[number]> extends never ? true : never = true;
void _allReasonsListed;

/** 서버가 정한, 다시 보내도 되는지와 언제인지. */
export interface Resume {
  reason: ApiErrorReason | null;
  retryAt: UnixSeconds | null;
  manualActionRequired: boolean;
}

/** 서버의 ApiError, 또는 서버에 닿지 못한 경우("network"). */
export class ApiRequestError extends Error implements Resume {
  readonly reason: ApiErrorReason | null;
  readonly retryAt: UnixSeconds | null;
  readonly manualActionRequired: boolean;

  constructor(
    readonly code: ApiErrorCode | "network",
    message: string,
    resume: Partial<Resume> = {},
  ) {
    super(message);
    this.name = "ApiRequestError";
    this.reason = resume.reason ?? null;
    this.retryAt = resume.retryAt ?? null;
    this.manualActionRequired = resume.manualActionRequired ?? false;
  }
}

function isApiErrorCode(x: unknown): x is ApiErrorCode {
  return typeof x === "string" && (API_ERROR_CODES as readonly string[]).includes(x);
}

function isApiErrorReason(x: unknown): x is ApiErrorReason {
  return typeof x === "string" && (API_ERROR_REASONS as readonly string[]).includes(x);
}

function readResume(err: { reason?: unknown; retryAt?: unknown; manualActionRequired?: unknown }): Resume {
  return {
    reason: isApiErrorReason(err.reason) ? err.reason : null,
    retryAt: typeof err.retryAt === "number" && Number.isFinite(err.retryAt) ? err.retryAt : null,
    manualActionRequired: err.manualActionRequired === true,
  };
}

async function parseError(res: Response): Promise<ApiRequestError> {
  try {
    const body: unknown = await res.json();
    if (typeof body === "object" && body !== null && "error" in body) {
      const err = (body as { error: unknown }).error;
      if (typeof err === "object" && err !== null) {
        const fields = err as { code?: unknown; message?: unknown; reason?: unknown; retryAt?: unknown; manualActionRequired?: unknown };
        const { code, message } = fields;
        if (isApiErrorCode(code) && typeof message === "string") return new ApiRequestError(code, message, readResume(fields));
      }
    }
  } catch {
    // 본문이 JSON이 아니다. 아래 문장으로 대신한다.
  }
  return new ApiRequestError("internal", `서버 응답을 읽지 못했습니다 (HTTP ${res.status})`);
}

/** GET 하나. 실패하면 ApiRequestError를 던진다. 중단(AbortError)은 그대로 던진다. */
export async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  return (await (await request(path, { method: "GET", signal })).json()) as T;
}

export function putJson<T>(path: string, body: unknown, opts: SendOptions = {}): Promise<T> {
  return sendJson<T>("PUT", path, JSON.stringify(body), opts);
}

export async function deleteJson(path: string, opts: SendOptions = {}): Promise<void> {
  await request(path, { method: "DELETE", signal: opts.signal, keepalive: opts.keepalive });
}

export interface SendOptions {
  signal?: AbortSignal;
  keepalive?: boolean;
}

export async function sendJson<T>(method: "PUT" | "POST", path: string, json: string, opts: SendOptions = {}): Promise<T> {
  const res = await request(path, {
    method,
    body: json,
    signal: opts.signal,
    keepalive: opts.keepalive,
    headers: { "Content-Type": "application/json" },
  });
  return (await res.json()) as T;
}

async function request(path: string, init: RequestInit): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(path, { ...init, headers: { Accept: "application/json", ...init.headers } });
  } catch (e) {
    if (init.signal?.aborted) throw e;
    throw new ApiRequestError("network", "서버에 연결하지 못했습니다");
  }
  const kiwoom = useKiwoomStore.getState();
  if (!res.ok) {
    const error = await parseError(res);
    if (error.manualActionRequired) kiwoom.reportStopped(error.message);
    if (error.reason === "kiwoom_timeout") kiwoom.reportNotice(error.message);
    throw error;
  }
  kiwoom.clearNotice();
  return res;
}
