import { expect, test } from "vitest";
import type { Watchlist } from "../api/generated/Watchlist";
import {
  addSymbol,
  addSymbols,
  assignGroup,
  createGroup,
  deleteGroup,
  displayOrder,
  duplicateWatchlist,
  groupNameProblem,
  listNameFrom,
  MAX_WATCH_GROUPS,
  moveGroupBy,
  moveSymbol,
  moveSymbolBy,
  nameProblem,
  nextGroupName,
  nextListName,
  parseWatchlists,
  removeSymbol,
  renameGroup,
  transferSymbol,
  ungroup,
  watchSections,
} from "./watchlist";

const list = ["005930", "000660", "035420"] as const;
const flat: Watchlist = { id: "L", name: "기본", symbols: [...list], groups: [] };
const symbolsOf = (l: Watchlist) => l.symbols;

const grouped = (): Watchlist => ({
  id: "L",
  name: "기본",
  symbols: ["1", "2", "3", "4", "5", "6"],
  groups: [{ id: "A", name: "반도체", symbols: ["4", "2"] }, { id: "B", name: "관찰", symbols: ["5"] }],
});

function expectInvariants(l: Watchlist) {
  const members = new Set(l.symbols);
  const grouped = l.groups.flatMap((g) => g.symbols);
  expect(grouped.every((c) => members.has(c)), "그룹의 종목은 목록에 있다").toBe(true);
  expect(new Set(grouped).size, "한 종목은 그룹 하나에만 있다").toBe(grouped.length);
  expect(new Set(l.groups.map((g) => g.name)).size).toBe(l.groups.length);
  expect(new Set(l.groups.map((g) => g.id)).size).toBe(l.groups.length);
}

test("넣으면 끝에 붙고, 이미 있으면 그대로다", () => {
  expect(addSymbol(list, "IDX:001")).toEqual([...list, "IDX:001"]);
  expect(addSymbol(list, "000660")).toBe(list);
});

test("여러 종목을 넣으면 없던 것만 처음 나온 순서대로 끝에 붙고, 새 것이 없으면 그대로다", () => {
  expect(addSymbols(list, ["035720", "000660", "035720", "051910"])).toEqual([...list, "035720", "051910"]);
  expect(addSymbols(list, ["005930", "000660"])).toBe(list);
  expect(addSymbols(list, [])).toBe(list);
});

test("지우면 그 종목만 빠지고, 없는 종목이면 그대로다", () => {
  expect(symbolsOf(removeSymbol(flat, "000660"))).toEqual(["005930", "035420"]);
  expect(removeSymbol(flat, "999999")).toBe(flat);
});

test("그룹에 있는 종목을 지우면 그룹에서도 빠진다", () => {
  const after = removeSymbol(grouped(), "2");
  expect(after).toEqual({ ...grouped(), symbols: ["1", "3", "4", "5", "6"], groups: [{ id: "A", name: "반도체", symbols: ["4"] }, grouped().groups[1]] });
  expectInvariants(after);
});

test("끌어 놓으면 그 자리로 옮긴다", () => {
  expect(symbolsOf(moveSymbol(flat, "035420", 0))).toEqual(["035420", "005930", "000660"]);
  expect(symbolsOf(moveSymbol(flat, "005930", 2))).toEqual(["000660", "035420", "005930"]);
  expect(symbolsOf(moveSymbol(flat, "005930", 99))).toEqual(["000660", "035420", "005930"]);
  expect(moveSymbol(flat, "005930", 0)).toBe(flat);
  expect(moveSymbol(flat, "999999", 0)).toBe(flat);
});

test("Alt+↑/↓는 한 칸씩 옮기고, 끝에서는 그대로다", () => {
  expect(symbolsOf(moveSymbolBy(flat, "000660", -1))).toEqual(["000660", "005930", "035420"]);
  expect(symbolsOf(moveSymbolBy(flat, "000660", 1))).toEqual(["005930", "035420", "000660"]);
  expect(moveSymbolBy(flat, "005930", -1)).toBe(flat);
  expect(moveSymbolBy(flat, "035420", 1)).toBe(flat);
});

test("화면 순서는 그룹 순서, 그룹 안 순서, 마지막에 그룹 없음을 목록 순서대로 둔다", () => {
  expect(watchSections(grouped()).map((s) => [s.group?.id ?? null, s.symbols])).toEqual([["A", ["4", "2"]], ["B", ["5"]], [null, ["1", "3", "6"]]]);
  expect(displayOrder(grouped())).toEqual(["4", "2", "5", "1", "3", "6"]);
  expect(watchSections(flat)).toEqual([{ group: null, symbols: flat.symbols }]);
});

test("그룹 안 종목은 그 그룹 안에서만 옮긴다", () => {
  const l = grouped();
  expect(moveSymbolBy(l, "2", -1).groups[0]!.symbols).toEqual(["2", "4"]);
  expect(moveSymbolBy(l, "2", -1).symbols).toBe(l.symbols);
  expect(moveSymbolBy(l, "4", -1)).toBe(l);
  expect(moveSymbolBy(l, "2", 1)).toBe(l);
  expect(moveSymbol(l, "2", 0).groups[0]!.symbols).toEqual(["2", "4"]);
});

test("그룹 없음의 종목은 그룹 없음 안에서 옮기고 그룹의 종목 자리는 그대로 둔다", () => {
  const l = grouped();
  const down = moveSymbolBy(l, "3", 1);
  expect(down.symbols).toEqual(["1", "2", "6", "4", "5", "3"]);
  expect(watchSections(down).at(-1)!.symbols).toEqual(["1", "6", "3"]);
  expect(down.groups).toBe(l.groups);
  expect(watchSections(moveSymbol(l, "6", 0)).at(-1)!.symbols).toEqual(["6", "1", "3"]);
  expect(moveSymbolBy(l, "1", -1)).toBe(l);
  expect(moveSymbolBy(l, "6", 1)).toBe(l);
});

test("그룹을 만들면 끝에 붙고, 이름이나 id가 겹치거나 20개면 그대로다", () => {
  const made = createGroup(grouped(), "C", "새 그룹");
  expect(made.groups.map((g) => [g.id, g.name, g.symbols])).toEqual([["A", "반도체", ["4", "2"]], ["B", "관찰", ["5"]], ["C", "새 그룹", []]]);
  expect(made.symbols).toEqual(grouped().symbols);
  const l = grouped();
  expect(createGroup(l, "C", "관찰")).toBe(l);
  expect(createGroup(l, "A", "다른 이름")).toBe(l);
  let full = flat;
  for (let i = 0; i < MAX_WATCH_GROUPS + 2; i++) full = createGroup(full, `G${i}`, `그룹 ${i}`);
  expect(full.groups).toHaveLength(MAX_WATCH_GROUPS);
});

test("종목을 넣어 그룹을 만들면 원래 그룹에서 옮겨 온다. 목록에 없는 종목은 넣지 않는다", () => {
  const made = createGroup(grouped(), "C", "새 그룹", ["2", "9", "1"]);
  expect(made.groups.map((g) => g.symbols)).toEqual([["4"], ["5"], ["2", "1"]]);
  expectInvariants(made);
});

test("그룹 이름 바꾸기는 겹치는 이름이나 같은 이름이면 그대로다", () => {
  const l = grouped();
  expect(renameGroup(l, "A", "칩").groups[0]!.name).toBe("칩");
  expect(renameGroup(l, "A", "관찰")).toBe(l);
  expect(renameGroup(l, "A", "반도체")).toBe(l);
  expect(renameGroup(l, "Z", "칩")).toBe(l);
});

test("그룹을 위·아래로 옮기고, 끝에서는 그대로다", () => {
  const l = grouped();
  expect(moveGroupBy(l, "B", -1).groups.map((g) => g.id)).toEqual(["B", "A"]);
  expect(moveGroupBy(l, "A", 1).groups.map((g) => g.id)).toEqual(["B", "A"]);
  expect(moveGroupBy(l, "A", -1)).toBe(l);
  expect(moveGroupBy(l, "B", 1)).toBe(l);
});

test("그룹을 풀면 종목은 그룹 없음으로 남고, 그룹을 지우면 종목도 빠진다", () => {
  const loose = ungroup(grouped(), "A");
  expect(loose.symbols).toEqual(grouped().symbols);
  expect(loose.groups.map((g) => g.id)).toEqual(["B"]);
  expect(watchSections(loose).at(-1)!.symbols).toEqual(["1", "2", "3", "4", "6"]);
  const gone = deleteGroup(grouped(), "A");
  expect(gone.symbols).toEqual(["1", "3", "5", "6"]);
  expect(gone.groups.map((g) => g.id)).toEqual(["B"]);
  const l = grouped();
  expect(ungroup(l, "Z")).toBe(l);
  expect(deleteGroup(l, "Z")).toBe(l);
});

test("종목을 다른 그룹이나 그룹 없음으로 옮기면 그 그룹 끝에 붙는다", () => {
  const l = grouped();
  const moved = assignGroup(l, "2", "B");
  expect(moved.groups.map((g) => g.symbols)).toEqual([["4"], ["5", "2"]]);
  expectInvariants(moved);
  expect(assignGroup(l, "1", "A").groups[0]!.symbols).toEqual(["4", "2", "1"]);
  const freed = assignGroup(l, "4", null);
  expect(freed.groups[0]!.symbols).toEqual(["2"]);
  expect(watchSections(freed).at(-1)!.symbols).toEqual(["1", "3", "4", "6"]);
  expect(assignGroup(l, "2", "A")).toBe(l);
  expect(assignGroup(l, "1", null)).toBe(l);
  expect(assignGroup(l, "9", "A")).toBe(l);
  expect(assignGroup(l, "1", "Z")).toBe(l);
});

test("목록을 복제하면 그룹도 복제하고 그룹 id는 새로 만든다", () => {
  let n = 0;
  const copy = duplicateWatchlist(grouped(), "L2", "기본 복사", () => `new-${++n}`);
  expect(copy).toEqual({ id: "L2", name: "기본 복사", symbols: grouped().symbols, groups: [{ id: "new-1", name: "반도체", symbols: ["4", "2"] }, { id: "new-2", name: "관찰", symbols: ["5"] }] });
});

test("새 그룹 이름은 비어 있는 가장 작은 번호이고, 그룹 이름은 목록 이름과 같은 규칙을 그 목록의 그룹끼리 적용한다", () => {
  expect(nextGroupName(flat)).toBe("그룹 1");
  expect(nextGroupName({ ...flat, groups: [{ id: "a", name: "그룹 1", symbols: [] }, { id: "b", name: "그룹 3", symbols: [] }] })).toBe("그룹 2");
  const l = grouped();
  expect(groupNameProblem(l, "  ", null)).toBe("이름을 입력하세요");
  expect(groupNameProblem(l, " 관찰 ", null)).toBe("같은 이름의 그룹이 있습니다");
  expect(groupNameProblem(l, "가".repeat(21), null)).toBe("이름은 20자까지입니다");
  expect(groupNameProblem(l, "관찰", "B")).toBeNull();
  expect(groupNameProblem(l, "기본", null)).toBeNull();
});

test("저장해 둔 목록은 그룹 키가 없어도 받고, 그룹의 틀린 종목은 걸러 낸다", () => {
  expect(parseWatchlists([{ id: "L", name: "기본", symbols: ["1"] }])).toEqual([{ id: "L", name: "기본", symbols: ["1"], groups: [] }]);
  expect(parseWatchlists([{ ...grouped(), groups: [{ id: "A", name: "가", symbols: ["2", "9", "2"] }, { id: "B", name: "나", symbols: ["2", "3"] }] }])![0]!.groups)
    .toEqual([{ id: "A", name: "가", symbols: ["2"] }, { id: "B", name: "나", symbols: ["3"] }]);
  expect(parseWatchlists([])).toBeNull();
  expect(parseWatchlists([{ id: "L", name: "기본", symbols: [1] }])).toBeNull();
  expect(parseWatchlists([{ id: "L", name: "기본", symbols: [], groups: [{ id: "A", symbols: [] }] }])).toBeNull();
  expect(parseWatchlists([{ id: "L", name: "기본", symbols: [], groups: {} }])).toBeNull();
});

const lists = (...xs: [string, string[]][]) => xs.map(([id, symbols]): Watchlist => ({ id, name: `이름 ${id}`, symbols, groups: [] }));

test("옮기기는 대상 끝에 붙이고 원래 목록에서 뺀다. 이미 있으면 빼기만 한다", () => {
  expect(transferSymbol(lists(["A", ["1", "2"]], ["B", ["3"]]), "A", "B", "1", "move")).toEqual(lists(["A", ["2"]], ["B", ["3", "1"]]));
  expect(transferSymbol(lists(["A", ["1", "2"]], ["B", ["1"]]), "A", "B", "1", "move")).toEqual(lists(["A", ["2"]], ["B", ["1"]]));
});

test("다른 목록으로 옮기면 원래 목록의 그룹에서도 빼고, 대상에서는 그룹 없음에 붙는다", () => {
  const target: Watchlist = { id: "T", name: "대상", symbols: ["7"], groups: [{ id: "C", name: "가", symbols: ["7"] }] };
  const [source, after] = transferSymbol([grouped(), target], "L", "T", "2", "move");
  expect(source!.groups[0]!.symbols).toEqual(["4"]);
  expect(after).toEqual({ ...target, symbols: ["7", "2"] });
  expectInvariants(source!);
  const [kept] = transferSymbol([grouped(), target], "L", "T", "2", "copy");
  expect(kept).toEqual(grouped());
});

test("복사는 원래 목록을 그대로 둔다. 이미 있거나 원래 목록에 없으면 바꾸지 않는다", () => {
  expect(transferSymbol(lists(["A", ["1"]], ["B", []]), "A", "B", "1", "copy")).toEqual(lists(["A", ["1"]], ["B", ["1"]]));
  const same = lists(["A", ["1"]], ["B", ["1"]]);
  expect(transferSymbol(same, "A", "B", "1", "copy")).toBe(same);
  expect(transferSymbol(same, "A", "B", "9", "move")).toBe(same);
  expect(transferSymbol(same, "A", "A", "1", "move")).toBe(same);
});

test("새 목록 이름은 비어 있는 가장 작은 번호다", () => {
  expect(nextListName([])).toBe("목록 1");
  expect(nextListName([{ id: "a", name: "목록 1", symbols: [], groups: [] }, { id: "b", name: "목록 3", symbols: [], groups: [] }])).toBe("목록 2");
});

test("다른 이름에서 만든 새 목록 이름은 20자로 자르고, 겹치면 뒤에 번호를 붙인다", () => {
  const named = (...names: string[]) => names.map((name, i): Watchlist => ({ id: `${i}`, name, symbols: [], groups: [] }));
  expect(listNameFrom(named("기본"), "  고가 200일 신고가 ")).toBe("고가 200일 신고가");
  expect(listNameFrom(named("고가 200일 신고가"), "고가 200일 신고가")).toBe("고가 200일 신고가 2");
  expect(listNameFrom(named("고가 200일 신고가", "고가 200일 신고가 2"), "고가 200일 신고가")).toBe("고가 200일 신고가 3");
  const long = "최근 5일 고가 200일 신고가와 거래량 60일 신고거래량";
  const cut = listNameFrom([], long);
  expect(cut).toBe("최근 5일 고가 200일 신고가와 거");
  expect([...cut].length).toBeLessThanOrEqual(20);
  expect(listNameFrom(named(cut), long)).toBe("최근 5일 고가 200일 신고가와 2");
  for (const name of [cut, listNameFrom(named(cut), long)]) expect(nameProblem([], name, null)).toBeNull();
});

test("이름은 앞뒤 공백을 지우고 비지 않으며 20자까지이며 다른 목록과 겹치지 않는다. 자기 이름은 그대로 둘 수 있다", () => {
  const two: Watchlist[] = [{ id: "a", name: "기본", symbols: [], groups: [] }, { id: "b", name: "반도체", symbols: [], groups: [] }];
  expect(nameProblem(two, "  ", null)).toBe("이름을 입력하세요");
  expect(nameProblem(two, " 기본 ", null)).toBe("같은 이름의 목록이 있습니다");
  expect(nameProblem(two, "가".repeat(21), null)).toBe("이름은 20자까지입니다");
  expect(nameProblem(two, "가".repeat(20), null)).toBeNull();
  expect(nameProblem(two, "반도체", "a")).toBe("같은 이름의 목록이 있습니다");
  expect(nameProblem(two, "반도체", "b")).toBeNull();
});
