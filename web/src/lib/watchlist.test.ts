import { expect, test } from "vitest";
import { addSymbol, moveSymbol, moveSymbolBy, nameProblem, nextListName, removeSymbol, transferSymbol } from "./watchlist";

const list = ["005930", "000660", "035420"] as const;

test("넣으면 끝에 붙고, 이미 있으면 그대로다", () => {
  expect(addSymbol(list, "IDX:001")).toEqual([...list, "IDX:001"]);
  expect(addSymbol(list, "000660")).toBe(list);
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

test("이름은 비지 않고 20자까지이며 다른 목록과 겹치지 않는다. 자기 이름은 그대로 둘 수 있다", () => {
  const two = [{ id: "a", name: "기본", symbols: [] }, { id: "b", name: "반도체", symbols: [] }];
  expect(nameProblem(two, "", null)).toBe("이름을 입력하세요");
  expect(nameProblem(two, "가".repeat(21), null)).toBe("이름은 20자까지입니다");
  expect(nameProblem(two, "가".repeat(20), null)).toBeNull();
  expect(nameProblem(two, "반도체", "a")).toBe("같은 이름의 목록이 있습니다");
  expect(nameProblem(two, "반도체", "b")).toBeNull();
});
