import { beforeEach, expect, test } from "vitest";
import { DEFAULT_WATCHLISTS, FIRST_WATCHLIST_ID, MAX_WATCHLISTS } from "../lib/watchlist";
import { activeWatchlist, useWatchlistStore, type WatchlistRemoval } from "./watchlist";

function commit(undo: WatchlistRemoval) {
  const state = useWatchlistStore.getState();
  const lists = undo.restore(state.lists);
  if (lists) state.load(lists, state.revision + 1);
}

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
  s.moveBy("L2", { code: "000660", groupId: null }, -1);
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
  const two = [...DEFAULT_WATCHLISTS, { id: "L2", name: "둘", symbols: [], groups: [] }];
  expect(activeWatchlist(two, "L2").id).toBe("L2");
  expect(activeWatchlist(two, "gone").id).toBe(FIRST_WATCHLIST_ID);
  expect(activeWatchlist(two, null).id).toBe(FIRST_WATCHLIST_ID);
});

test("복제는 이름을 겹치지 않게 만들고 종목 순서를 독립적으로 보존한다", () => {
  const s = useWatchlistStore.getState();
  s.addAll(FIRST_WATCHLIST_ID, ["000660", "005930"]);
  s.duplicate(FIRST_WATCHLIST_ID, "copy1");
  s.duplicate(FIRST_WATCHLIST_ID, "copy2");
  s.move("copy1", { code: "005930", groupId: null }, 0);
  expect(useWatchlistStore.getState().lists).toMatchObject([
    { name: "기본", symbols: ["000660", "005930"], groups: [] },
    { name: "기본 복사", symbols: ["005930", "000660"], groups: [] },
    { name: "기본 복사 2", symbols: ["000660", "005930"], groups: [] },
  ]);
});

test("빼기 되돌리기는 원래 순서를 한 번만 복원하고 없는 종목은 작업을 만들지 않는다", () => {
  const s = useWatchlistStore.getState();
  s.addAll(FIRST_WATCHLIST_ID, ["000660", "005930", "035420"]);
  expect(s.removeFromListWithUndo(FIRST_WATCHLIST_ID, "999999")).toBeNull();
  const undo = s.removeFromListWithUndo(FIRST_WATCHLIST_ID, "005930")!;
  expect(undo.available()).toBe(true);
  commit(undo);
  expect(useWatchlistStore.getState().lists[0]!.symbols).toEqual(["000660", "005930", "035420"]);
  expect(undo.available()).toBe(false);
  const revision = useWatchlistStore.getState().revision;
  commit(undo);
  expect(useWatchlistStore.getState().revision).toBe(revision);
});

test("다른 목록 편집과 서버 재적재 뒤 오래된 빼기 되돌리기는 실행되지 않는다", () => {
  const s = useWatchlistStore.getState();
  s.addAll(FIRST_WATCHLIST_ID, ["000660", "005930"]);
  const undo = s.removeFromListWithUndo(FIRST_WATCHLIST_ID, "005930")!;
  const notified = { count: 0 };
  const unsubscribe = undo.subscribe(() => notified.count++);
  s.create("next", "새 목록");
  expect(notified.count).toBeGreaterThan(0);
  expect(undo.available()).toBe(false);
  commit(undo);
  expect(useWatchlistStore.getState().lists[0]!.symbols).toEqual(["000660"]);
  const next = s.removeFromListWithUndo(FIRST_WATCHLIST_ID, "000660")!;
  s.load([{ id: FIRST_WATCHLIST_ID, name: "서버", symbols: ["035420"], groups: [] }]);
  commit(next);
  expect(next.available()).toBe(false);
  expect(useWatchlistStore.getState().lists[0]!.symbols).toEqual(["035420"]);
  unsubscribe();
});

test("바깥에서 복제한 목록을 유지하며 해당 종목만 원래 위치에 다시 넣는다", () => {
  const s = useWatchlistStore.getState();
  s.addAll(FIRST_WATCHLIST_ID, ["000660", "005930", "035420"]);
  const undo = s.removeFromListWithUndo(FIRST_WATCHLIST_ID, "005930")!;
  s.load([
    { id: FIRST_WATCHLIST_ID, name: "기본", symbols: ["000660", "035420"], groups: [] },
    { id: "copy", name: "기본 복사", symbols: ["000660", "035420"], groups: [] },
  ]);
  expect(undo.available()).toBe(true);
  commit(undo);
  expect(useWatchlistStore.getState().lists).toEqual([
    { id: FIRST_WATCHLIST_ID, name: "기본", symbols: ["000660", "005930", "035420"], groups: [] },
    { id: "copy", name: "기본 복사", symbols: ["000660", "035420"], groups: [] },
  ]);
});

test.each([
  { name: "목록 삭제", lists: [{ id: "other", name: "다른 목록", symbols: [], groups: [] }] },
  { name: "이름 변경", lists: [{ id: FIRST_WATCHLIST_ID, name: "새 이름", symbols: ["000660", "035420"], groups: [] }] },
  { name: "다른 종목 변경", lists: [{ id: FIRST_WATCHLIST_ID, name: "기본", symbols: ["035420", "000660"], groups: [] }] },
  { name: "종목 재추가", lists: [{ id: FIRST_WATCHLIST_ID, name: "기본", symbols: ["000660", "005930", "035420"], groups: [] }] },
])("바깥에서 $name 뒤 되돌리기는 비활성이며 눌러도 바뀌지 않는다", ({ lists }) => {
  const s = useWatchlistStore.getState();
  s.addAll(FIRST_WATCHLIST_ID, ["000660", "005930", "035420"]);
  const undo = s.removeFromListWithUndo(FIRST_WATCHLIST_ID, "005930")!;
  s.load(lists);
  expect(undo.available()).toBe(false);
  const before = useWatchlistStore.getState();
  commit(undo);
  expect(useWatchlistStore.getState()).toBe(before);
});

test("마지막 종목을 뺀 작업은 목록 끝에 한 번만 다시 넣는다", () => {
  const s = useWatchlistStore.getState();
  s.addAll(FIRST_WATCHLIST_ID, ["000660", "005930"]);
  const undo = s.removeFromListWithUndo(FIRST_WATCHLIST_ID, "005930")!;
  s.load([{ id: FIRST_WATCHLIST_ID, name: "기본", symbols: ["000660"], groups: [] }]);
  commit(undo);
  commit(undo);
  expect(useWatchlistStore.getState().lists[0]!.symbols).toEqual(["000660", "005930"]);
});

test("그룹 안 종목을 되돌리면 원래 그룹의 원래 자리로 돌아간다", () => {
  const s = useWatchlistStore.getState();
  s.addAll(FIRST_WATCHLIST_ID, ["000660", "005930", "035420", "051910"]);
  s.createGroup(FIRST_WATCHLIST_ID, "G", "반도체", ["051910", "005930", "000660"]);
  const undo = s.removeFromListWithUndo(FIRST_WATCHLIST_ID, "005930")!;
  expect(useWatchlistStore.getState().lists[0]!.groups[0]!.symbols).toEqual(["051910", "000660"]);
  commit(undo);
  expect(useWatchlistStore.getState().lists[0]).toMatchObject({
    symbols: ["000660", "005930", "035420", "051910"],
    groups: [{ id: "G", name: "반도체", symbols: ["051910", "005930", "000660"] }],
  });
});

test("바깥에서 그룹이 바뀐 뒤 되돌리기는 비활성이며 눌러도 바뀌지 않는다", () => {
  const s = useWatchlistStore.getState();
  s.addAll(FIRST_WATCHLIST_ID, ["000660", "005930"]);
  s.createGroup(FIRST_WATCHLIST_ID, "G", "반도체", ["005930", "000660"]);
  const undo = s.removeFromListWithUndo(FIRST_WATCHLIST_ID, "005930")!;
  s.load([{ id: FIRST_WATCHLIST_ID, name: "기본", symbols: ["000660"], groups: [] }]);
  expect(undo.available()).toBe(false);
  const before = useWatchlistStore.getState();
  commit(undo);
  expect(useWatchlistStore.getState()).toBe(before);
});

test("그룹 편집은 목록 하나만 바꾸고 편집마다 revision이 늘며, 같은 그룹을 다시 load해도 그대로다", () => {
  const s = useWatchlistStore.getState();
  s.addAll(FIRST_WATCHLIST_ID, ["000660", "005930"]);
  const r0 = useWatchlistStore.getState().revision;
  s.createGroup(FIRST_WATCHLIST_ID, "G", "반도체");
  s.addToGroup(FIRST_WATCHLIST_ID, "005930", "G");
  s.renameGroup(FIRST_WATCHLIST_ID, "G", "칩");
  s.createGroup(FIRST_WATCHLIST_ID, "H", "관찰");
  s.moveGroupBy(FIRST_WATCHLIST_ID, "H", -1);
  expect(useWatchlistStore.getState().revision).toBe(r0 + 5);
  const grouped = useWatchlistStore.getState().lists[0]!;
  expect(grouped.groups.map((g) => [g.id, g.name, g.symbols])).toEqual([["H", "관찰", []], ["G", "칩", ["005930"]]]);
  s.load(structuredClone([grouped]));
  expect(useWatchlistStore.getState().lists[0]).toBe(grouped);
  s.ungroup(FIRST_WATCHLIST_ID, "H");
  s.deleteGroup(FIRST_WATCHLIST_ID, "G");
  expect(useWatchlistStore.getState().lists[0]).toMatchObject({ symbols: ["000660"], groups: [] });
});

test("목록 복제는 그룹을 새 id로 복제한다", () => {
  const s = useWatchlistStore.getState();
  s.addAll(FIRST_WATCHLIST_ID, ["000660", "005930"]);
  s.createGroup(FIRST_WATCHLIST_ID, "G", "반도체", ["005930"]);
  s.duplicate(FIRST_WATCHLIST_ID, "copy");
  const copy = useWatchlistStore.getState().lists[1]!;
  expect(copy).toMatchObject({ id: "copy", name: "기본 복사", symbols: ["000660", "005930"], groups: [{ name: "반도체", symbols: ["005930"] }] });
  expect(copy.groups[0]!.id).not.toBe("G");
});


test("그룹 행 빼기 되돌리기는 모든 그룹 순서와 공유 소속을 그대로 복원한다", () => {
  const s = useWatchlistStore.getState();
  s.addAll(FIRST_WATCHLIST_ID, ["000660", "005930"]);
  s.createGroup(FIRST_WATCHLIST_ID, "A", "첫째", ["000660", "005930"]);
  s.createGroup(FIRST_WATCHLIST_ID, "B", "둘째", ["005930", "000660"]);
  const before = structuredClone(useWatchlistStore.getState().lists);
  const undo = s.removeRowWithUndo(FIRST_WATCHLIST_ID, { code: "005930", groupId: "B" })!;
  expect(useWatchlistStore.getState().lists[0]!.groups.map((g) => g.symbols)).toEqual([["000660", "005930"], ["000660"]]);
  commit(undo);
  expect(useWatchlistStore.getState().lists).toEqual(before);
});
