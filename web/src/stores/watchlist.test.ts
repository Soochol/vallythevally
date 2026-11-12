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

test("결과 전체를 한 번에 넣으면 revision은 한 번만 는다", () => {
  const s = useWatchlistStore.getState();
  s.create("L2", "둘");
  s.add("L2", "000002");
  const codes = Array.from({ length: 3960 }, (_, i) => String(i).padStart(6, "0"));
  const before = useWatchlistStore.getState().revision;
  useWatchlistStore.getState().addAll("L2", codes);
  const after = useWatchlistStore.getState();
  expect(after.revision - before).toBe(1);
  expect(after.lists[1]!.symbols).toHaveLength(3960);
  expect(after.lists[1]!.symbols.slice(0, 3)).toEqual(["000002", "000000", "000001"]);
  useWatchlistStore.getState().addAll("L2", codes);
  expect(useWatchlistStore.getState().revision).toBe(after.revision);
});

test("가리키는 목록이 없으면 첫 목록을 본다", () => {
  const two = [...DEFAULT_WATCHLISTS, { id: "L2", name: "둘", symbols: [] }];
  expect(activeWatchlist(two, "L2").id).toBe("L2");
  expect(activeWatchlist(two, "gone").id).toBe(FIRST_WATCHLIST_ID);
  expect(activeWatchlist(two, null).id).toBe(FIRST_WATCHLIST_ID);
});

test("복제는 이름을 겹치지 않게 만들고 종목 순서를 독립적으로 보존한다", () => {
  const s = useWatchlistStore.getState();
  s.addAll(FIRST_WATCHLIST_ID, ["000660", "005930"]);
  s.duplicate(FIRST_WATCHLIST_ID, "copy1");
  s.duplicate(FIRST_WATCHLIST_ID, "copy2");
  s.move("copy1", "005930", 0);
  expect(useWatchlistStore.getState().lists).toMatchObject([
    { name: "기본", symbols: ["000660", "005930"] },
    { name: "기본 복사", symbols: ["005930", "000660"] },
    { name: "기본 복사 2", symbols: ["000660", "005930"] },
  ]);
});

test("빼기 되돌리기는 원래 순서를 한 번만 복원하고 없는 종목은 작업을 만들지 않는다", () => {
  const s = useWatchlistStore.getState();
  s.addAll(FIRST_WATCHLIST_ID, ["000660", "005930", "035420"]);
  expect(s.removeWithUndo(FIRST_WATCHLIST_ID, "999999")).toBeNull();
  const undo = s.removeWithUndo(FIRST_WATCHLIST_ID, "005930")!;
  expect(undo.available()).toBe(true);
  undo.run();
  expect(useWatchlistStore.getState().lists[0]!.symbols).toEqual(["000660", "005930", "035420"]);
  expect(undo.available()).toBe(false);
  const revision = useWatchlistStore.getState().revision;
  undo.run();
  expect(useWatchlistStore.getState().revision).toBe(revision);
});

test("다른 목록 편집과 서버 재적재 뒤 오래된 빼기 되돌리기는 실행되지 않는다", () => {
  const s = useWatchlistStore.getState();
  s.addAll(FIRST_WATCHLIST_ID, ["000660", "005930"]);
  const undo = s.removeWithUndo(FIRST_WATCHLIST_ID, "005930")!;
  const notified = { count: 0 };
  const unsubscribe = undo.subscribe(() => notified.count++);
  s.create("next", "새 목록");
  expect(notified.count).toBeGreaterThan(0);
  expect(undo.available()).toBe(false);
  undo.run();
  expect(useWatchlistStore.getState().lists[0]!.symbols).toEqual(["000660"]);
  const next = s.removeWithUndo(FIRST_WATCHLIST_ID, "000660")!;
  s.load([{ id: FIRST_WATCHLIST_ID, name: "서버", symbols: ["035420"] }]);
  next.run();
  expect(next.available()).toBe(false);
  expect(useWatchlistStore.getState().lists[0]!.symbols).toEqual(["035420"]);
  unsubscribe();
});
