export const PAYLOAD_LIMIT_BYTES = 64 * 1024;

const encoder = new TextEncoder();

export const byteLength = (json: string) => encoder.encode(json).length;

export const exceedsLimit = (value: unknown) => byteLength(JSON.stringify(value)) > PAYLOAD_LIMIT_BYTES;
