/** 서버가 받는 `chartSettings`와 `UiState`의 최대 크기(backend.md §8.2, 넘으면 413). */
export const PAYLOAD_LIMIT_BYTES = 64 * 1024;

const encoder = new TextEncoder();

/** 보낼 JSON 문자열의 UTF-8 바이트 수. 한글은 글자당 3바이트다. */
export const byteLength = (json: string) => encoder.encode(json).length;

export const exceedsLimit = (value: unknown) => byteLength(JSON.stringify(value)) > PAYLOAD_LIMIT_BYTES;
