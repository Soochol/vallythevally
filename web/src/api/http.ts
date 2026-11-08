import type { ApiErrorCode } from "./generated/ApiErrorCode";

const API_ERROR_CODES = [
  "bad_request",
  "not_found",
  "unknown_symbol",
  "kiwoom_unavailable",
  "kiwoom_auth_failed",
  "conflict",
  "payload_too_large",
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
  let res: Response;
  try {
    res = await fetch(path, { signal, headers: { Accept: "application/json" } });
  } catch (e) {
    if (signal?.aborted) throw e;
    throw new ApiRequestError("network", "서버에 연결하지 못했습니다");
  }
  if (!res.ok) throw await parseError(res);
  return (await res.json()) as T;
}
