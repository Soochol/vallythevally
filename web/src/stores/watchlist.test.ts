import { beforeEach, expect, test } from "vitest";
import { DEFAULT_WATCHLISTS, FIRST_WATCHLIST_ID, MAX_WATCHLISTS } from "../lib/watchlist";
import { activeWatchlist, useWatchlistStore } from "./watchlist";

beforeEach(() => useWatchlistStore.getState().load(DEFAULT_WATCHLISTS));

test("마지막 목록은 지우지 않는다", () => {
  const before = useWatchlistStore.getState();
  before.removeList(FIRST_WATCHLIST_ID);
  expect(useWatchlistStore.getState().lists).toBe(before.lists);
  expect(useWatchlistStore.getState().revision).toBe(before.revision);
});

test("목록은 20개까지 만든다", () => {
  for (let i = 0; i < MAX_WATCHLISTS + 3; i++) useWatchlistStore.getState().create(`L${i}`, `목록 ${i}`);
  expect(useWatchlistStore.getState().lists).toHaveLength(MAX_WATCHLISTS);
});

test("종목 편집은 그 목록만 바꾸고 편집마다 revision이 는다", () => {
  const s = useWatchlistStore.getState();
  s.create("L2", "둘");
  s.add("L2", "005930");
  s.add("L2", "000660");
  s.moveBy("L2", "000660", -1);
  s.add("L2", "005930");
  const after = useWatchlistStore.getState();
  expect(after.lists.map((l) => l.symbols)).toEqual([[], ["000660", "005930"]]);
  expect(after.revision - s.revision).toBe(4);
});

test("가리키는 목록이 없으면 첫 목록을 본다", () => {
  const two = [...DEFAULT_WATCHLISTS, { id: "L2", name: "둘", symbols: [] }];
  expect(activeWatchlist(two, "L2").id).toBe("L2");
  expect(activeWatchlist(two, "gone").id).toBe(FIRST_WATCHLIST_ID);
  expect(activeWatchlist(two, null).id).toBe(FIRST_WATCHLIST_ID);
});
