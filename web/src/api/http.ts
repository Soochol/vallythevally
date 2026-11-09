import type { ApiErrorCode } from "./generated/ApiErrorCode";

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

/** 서버의 ApiError, 또는 서버에 닿지 못한 경우("network"). */
export class ApiRequestError extends Error {
  constructor(
    readonly code: ApiErrorCode | "network",
    message: string,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

function isApiErrorCode(x: unknown): x is ApiErrorCode {
  return typeof x === "string" && (API_ERROR_CODES as readonly string[]).includes(x);
}

async function parseError(res: Response): Promise<ApiRequestError> {
  try {
    const body: unknown = await res.json();
    if (typeof body === "object" && body !== null && "error" in body) {
      const err = (body as { error: unknown }).error;
      if (typeof err === "object" && err !== null) {
        const { code, message } = err as { code?: unknown; message?: unknown };
        if (isApiErrorCode(code) && typeof message === "string") return new ApiRequestError(code, message);
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

/** PUT 하나. 본문은 JSON으로 보낸다. 응답 본문을 돌려준다. */
export function putJson<T>(path: string, body: unknown, opts: SendOptions = {}): Promise<T> {
  return sendJson<T>("PUT", path, JSON.stringify(body), opts);
}

/** DELETE 하나. 응답 본문은 읽지 않는다. */
export async function deleteJson(path: string, opts: SendOptions = {}): Promise<void> {
  await request(path, { method: "DELETE", signal: opts.signal, keepalive: opts.keepalive });
}

export interface SendOptions {
  signal?: AbortSignal;
  /** 탭이 닫히는 중에도 요청을 끝까지 보낸다(frontend.md §3.7). */
  keepalive?: boolean;
}

/** 이미 직렬화한 JSON 본문을 보낸다. 자동 저장이 바이트 수를 잰 그 문자열을 그대로 보낸다. */
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
  if (!res.ok) throw await parseError(res);
  return res;
}
