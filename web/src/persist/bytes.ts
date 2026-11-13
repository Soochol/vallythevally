import { MAX_WATCH_GROUPS, MAX_WATCHLIST_NAME, MAX_WATCHLISTS } from "../lib/watchlist";

export const PAYLOAD_LIMIT_BYTES = 64 * 1024;

const encoder = new TextEncoder();

export const byteLength = (json: string) => encoder.encode(json).length;

const MAX_WATCHLIST_ID_BYTES = 64;
const LONGEST_WATCH_GROUP_WRAPPER_BYTES = byteLength('{"id":"","name":"","symbols":[]},') + MAX_WATCHLIST_ID_BYTES + 4 * MAX_WATCHLIST_NAME;
const LONGEST_WATCHLIST_WRAPPER_BYTES = LONGEST_WATCH_GROUP_WRAPPER_BYTES + byteLength('"groups":[],') + MAX_WATCH_GROUPS * LONGEST_WATCH_GROUP_WRAPPER_BYTES;
export const WATCHLISTS_LIMIT_BYTES = 2 * PAYLOAD_LIMIT_BYTES + MAX_WATCHLISTS * LONGEST_WATCHLIST_WRAPPER_BYTES;

export const exceedsLimit = (value: unknown, limit = PAYLOAD_LIMIT_BYTES) => byteLength(JSON.stringify(value)) > limit;
