import { expect, test } from "vitest";
import { addSymbol, addSymbols, listNameFrom, moveSymbol, moveSymbolBy, nameProblem, nextListName, removeSymbol, transferSymbol } from "./watchlist";

const list = ["005930", "000660", "035420"] as const;

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
  expect(removeSymbol(list, "000660")).toEqual(["005930", "035420"]);
  expect(removeSymbol(list, "999999")).toBe(list);
});

test("끌어 놓으면 그 자리로 옮긴다", () => {
  expect(moveSymbol(list, "035420", 0)).toEqual(["035420", "005930", "000660"]);
  expect(moveSymbol(list, "005930", 2)).toEqual(["000660", "035420", "005930"]);
  expect(moveSymbol(list, "005930", 99)).toEqual(["000660", "035420", "005930"]);
  expect(moveSymbol(list, "005930", 0)).toBe(list);
  expect(moveSymbol(list, "999999", 0)).toBe(list);
});

test("Alt+↑/↓는 한 칸씩 옮기고, 끝에서는 그대로다", () => {
  expect(moveSymbolBy(list, "000660", -1)).toEqual(["000660", "005930", "035420"]);
  expect(moveSymbolBy(list, "000660", 1)).toEqual(["005930", "035420", "000660"]);
  expect(moveSymbolBy(list, "005930", -1)).toBe(list);
  expect(moveSymbolBy(list, "035420", 1)).toBe(list);
});

const lists = (...xs: [string, string[]][]) => xs.map(([id, symbols]) => ({ id, name: `이름 ${id}`, symbols }));

test("옮기기는 대상 끝에 붙이고 원래 목록에서 뺀다. 이미 있으면 빼기만 한다", () => {
  expect(transferSymbol(lists(["A", ["1", "2"]], ["B", ["3"]]), "A", "B", "1", "move")).toEqual(lists(["A", ["2"]], ["B", ["3", "1"]]));
  expect(transferSymbol(lists(["A", ["1", "2"]], ["B", ["1"]]), "A", "B", "1", "move")).toEqual(lists(["A", ["2"]], ["B", ["1"]]));
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
  expect(nextListName([{ id: "a", name: "목록 1", symbols: [] }, { id: "b", name: "목록 3", symbols: [] }])).toBe("목록 2");
});

test("다른 이름에서 만든 새 목록 이름은 20자로 자르고, 겹치면 뒤에 번호를 붙인다", () => {
  const named = (...names: string[]) => names.map((name, i) => ({ id: `${i}`, name, symbols: [] }));
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
  const two = [{ id: "a", name: "기본", symbols: [] }, { id: "b", name: "반도체", symbols: [] }];
  expect(nameProblem(two, "  ", null)).toBe("이름을 입력하세요");
  expect(nameProblem(two, " 기본 ", null)).toBe("같은 이름의 목록이 있습니다");
  expect(nameProblem(two, "가".repeat(21), null)).toBe("이름은 20자까지입니다");
  expect(nameProblem(two, "가".repeat(20), null)).toBeNull();
  expect(nameProblem(two, "반도체", "a")).toBe("같은 이름의 목록이 있습니다");
  expect(nameProblem(two, "반도체", "b")).toBeNull();
});
