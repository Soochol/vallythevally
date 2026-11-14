import { expect, test } from "vitest";
import { MAX_WATCH_GROUPS, MAX_WATCHLIST_NAME, MAX_WATCHLISTS } from "../lib/watchlist";
import { byteLength, exceedsLimit, PAYLOAD_LIMIT_BYTES, WATCHLISTS_LIMIT_BYTES } from "./bytes";

test("관심종목 본문 한도는 서버와 같은 100개 겹치는 그룹과 가장 긴 감싸개를 포함한다", () => {
  const groupWrapper = byteLength('{"id":"","name":"","symbols":[]},') + 64 + 4 * MAX_WATCHLIST_NAME;
  const listWrapper = groupWrapper + byteLength('"groups":[],') + MAX_WATCH_GROUPS * groupWrapper;
  expect(WATCHLISTS_LIMIT_BYTES).toBe((MAX_WATCH_GROUPS + 1) * PAYLOAD_LIMIT_BYTES + MAX_WATCHLISTS * listWrapper);
  const codes = Array.from({ length: 7274 }, (_, i) => String(100_000 + i));
  const lists = Array.from({ length: MAX_WATCHLISTS }, (_, i) => ({
    id: String(i).padStart(64, "0"), name: "𝄞".repeat(18) + String(i).padStart(2, "0"), symbols: i === 0 ? codes : [],
    groups: Array.from({ length: MAX_WATCH_GROUPS }, (_, j) => ({ id: `${i}-${j}`.padStart(64, "0"), name: "𝄞".repeat(17) + String(j).padStart(3, "0"), symbols: i === 0 ? codes : [] })),
  }));
  expect(exceedsLimit({ lists, revision: Number.MAX_SAFE_INTEGER }, WATCHLISTS_LIMIT_BYTES)).toBe(false);
  expect(exceedsLimit("x".repeat(WATCHLISTS_LIMIT_BYTES - 2), WATCHLISTS_LIMIT_BYTES)).toBe(false);
  expect(exceedsLimit("x".repeat(WATCHLISTS_LIMIT_BYTES - 1), WATCHLISTS_LIMIT_BYTES)).toBe(true);
});
