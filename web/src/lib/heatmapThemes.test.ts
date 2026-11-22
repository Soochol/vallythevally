import { describe, expect, it } from "vitest";
import type { HeatmapTheme } from "../api/generated/HeatmapTheme";
import type { Watchlist } from "../api/generated/Watchlist";
import {
  addSymbolToTheme,
  createTheme,
  deleteTheme,
  importNotices,
  importWatchlistGroups,
  MAX_THEME_NAME_CHARS,
  MAX_THEME_SYMBOLS,
  MAX_THEMES,
  moveItem,
  moveSymbol,
  nextRevision,
  removeSymbolFromTheme,
  renameTheme,
  sameThemes,
  themeNameProblem,
  themesProblem,
} from "./heatmapThemes";

const theme = (id: string, name: string, symbols: string[] = []): HeatmapTheme => ({ id, name, symbols });
const codes = (count: number, from = 100000) => Array.from({ length: count }, (_, i) => String(from + i));
const ids = () => {
  let n = 0;
  return () => `new-${++n}`;
};

describe("themeNameProblem", () => {
  const themes = [theme("a", "반도체"), theme("b", "지주")];
  it("정상 이름과 자기 자신의 이름은 통과한다", () => {
    expect(themeNameProblem("로봇", themes, null)).toBeNull();
    expect(themeNameProblem("반도체", themes, "a")).toBeNull();
  });
  it("비었거나 공백뿐이면 막는다", () => {
    expect(themeNameProblem("", themes, null)).toBe("테마 이름을 적어 주세요");
    expect(themeNameProblem("   ", themes, null)).toBe("테마 이름을 적어 주세요");
  });
  it("앞뒤 공백을 막는다", () => {
    expect(themeNameProblem(" 로봇", themes, null)).toBe("테마 이름 앞뒤에 공백을 둘 수 없습니다");
  });
  it("40자를 넘으면 막고 40자는 받는다", () => {
    expect(themeNameProblem("가".repeat(MAX_THEME_NAME_CHARS), themes, null)).toBeNull();
    expect(themeNameProblem("가".repeat(MAX_THEME_NAME_CHARS + 1), themes, null)).toBe("테마 이름은 40자까지입니다");
  });
  it("다른 테마와 같은 이름을 막는다", () => {
    expect(themeNameProblem("지주", themes, "a")).toBe("같은 이름의 테마가 이미 있습니다: 지주");
  });
});

describe("테마 편집", () => {
  it("추가는 끝에 빈 테마를 붙이고 이름 검사를 한다", () => {
    const made = createTheme([theme("a", "반도체")], "b", "지주");
    expect(made).toEqual({ ok: true, themes: [theme("a", "반도체"), theme("b", "지주")] });
    expect(createTheme([theme("a", "반도체")], "b", "반도체")).toEqual({ ok: false, problem: "같은 이름의 테마가 이미 있습니다: 반도체" });
  });
  it("테마가 100개면 더 만들지 못한다", () => {
    const full = Array.from({ length: MAX_THEMES }, (_, i) => theme(`t${i}`, `이름${i}`));
    expect(createTheme(full, "x", "새것")).toEqual({ ok: false, problem: "테마는 100개까지 만들 수 있습니다" });
  });
  it("이름 바꾸기는 같은 이름이면 그대로 두고 중복·빈 이름은 막는다", () => {
    const themes = [theme("a", "반도체"), theme("b", "지주")];
    expect(renameTheme(themes, "a", "반도체")).toEqual({ ok: true, themes });
    expect(renameTheme(themes, "a", "로봇")).toEqual({ ok: true, themes: [theme("a", "로봇"), theme("b", "지주")] });
    expect(renameTheme(themes, "a", "지주")).toMatchObject({ ok: false });
    expect(renameTheme(themes, "a", "")).toMatchObject({ ok: false });
  });
  it("지우기는 그 테마만 뺀다", () => {
    expect(deleteTheme([theme("a", "반도체"), theme("b", "지주")], "a")).toEqual([theme("b", "지주")]);
  });
  it("moveItem은 자리를 옮기고 범위 밖이면 그대로 둔다", () => {
    expect(moveItem(["a", "b", "c"], 0, 2)).toEqual(["b", "c", "a"]);
    expect(moveItem(["a", "b", "c"], 2, 0)).toEqual(["c", "a", "b"]);
    expect(moveItem(["a", "b", "c"], 0, -1)).toEqual(["a", "b", "c"]);
    expect(moveItem(["a", "b", "c"], 1, 3)).toEqual(["a", "b", "c"]);
  });
});

describe("종목 편집", () => {
  const themes = [theme("a", "반도체", ["005930"]), theme("b", "지주", ["028260"])];
  it("넣으면 그 테마 끝에 붙고 다른 테마는 그대로다", () => {
    const { themes: next, outcome } = addSymbolToTheme(themes, "a", "000660");
    expect(outcome).toBe("added");
    expect(next).toEqual([theme("a", "반도체", ["005930", "000660"]), theme("b", "지주", ["028260"])]);
  });
  it("이미 있으면 duplicate, 지수면 index, 없는 테마면 missing이고 바뀌지 않는다", () => {
    expect(addSymbolToTheme(themes, "a", "005930")).toEqual({ themes, outcome: "duplicate" });
    expect(addSymbolToTheme(themes, "a", "IDX:001")).toEqual({ themes, outcome: "index" });
    expect(addSymbolToTheme(themes, "z", "000660")).toEqual({ themes, outcome: "missing" });
  });
  it("60개가 차 있으면 full로 막는다", () => {
    const full = [theme("a", "꽉참", codes(MAX_THEME_SYMBOLS))];
    expect(addSymbolToTheme(full, "a", "999999")).toEqual({ themes: full, outcome: "full" });
  });
  it("빼기와 순서 바꾸기", () => {
    expect(removeSymbolFromTheme(themes, "a", "005930")[0]!.symbols).toEqual([]);
    expect(removeSymbolFromTheme(themes, "a", "111111")).toEqual(themes);
    const three = [theme("a", "반도체", ["1", "2", "3"])];
    expect(moveSymbol(three, "a", 2, 0)[0]!.symbols).toEqual(["3", "1", "2"]);
  });
});

describe("themesProblem", () => {
  it("올바른 문서는 문제가 없다", () => {
    expect(themesProblem([theme("a", "반도체", ["005930"]), theme("b", "지주")])).toBeNull();
  });
  it("이름·개수·중복·지수를 찾는다", () => {
    expect(themesProblem([theme("a", "")])).toBe("테마 이름을 적어 주세요");
    expect(themesProblem([theme("a", "같음"), theme("b", "같음")])).toBe("같은 이름의 테마가 이미 있습니다: 같음");
    expect(themesProblem([theme("a", "많음", codes(MAX_THEME_SYMBOLS + 1))])).toContain("60개까지");
    expect(themesProblem([theme("a", "겹침", ["005930", "005930"])])).toContain("두 번");
    expect(themesProblem([theme("a", "지수", ["IDX:001"])])).toContain("지수");
  });
});

describe("sameThemes와 revision", () => {
  it("이름·종목·순서가 모두 같을 때만 같다", () => {
    const base = [theme("a", "반도체", ["1", "2"])];
    expect(sameThemes(base, [theme("a", "반도체", ["1", "2"])])).toBe(true);
    expect(sameThemes(base, [theme("a", "반도체", ["2", "1"])])).toBe(false);
    expect(sameThemes(base, [theme("a", "다름", ["1", "2"])])).toBe(false);
    expect(sameThemes(base, [])).toBe(false);
  });
  it("revision은 저장된 값 다음이거나 지금 시각 가운데 큰 값이다", () => {
    expect(nextRevision(7, 1_000)).toBe(1_000);
    expect(nextRevision(5_000, 1_000)).toBe(5_001);
  });
});

describe("importWatchlistGroups", () => {
  const list = (groups: { name: string; symbols: string[] }[]): Watchlist => ({
    id: "w",
    name: "히트맵",
    symbols: groups.flatMap((g) => g.symbols),
    groups: groups.map((g, i) => ({ id: `g${i}`, ...g })),
  });

  it("그룹을 같은 이름·순서의 테마로 뒤에 더한다", () => {
    const { themes, report } = importWatchlistGroups([theme("a", "기존")], list([{ name: "반도체", symbols: ["005930"] }, { name: "지주", symbols: ["028260", "086520"] }]), ids());
    expect(themes).toEqual([theme("a", "기존"), theme("new-1", "반도체", ["005930"]), theme("new-2", "지주", ["028260", "086520"])]);
    expect(report.imported).toEqual(["반도체", "지주"]);
  });
  it("이름이 같은 테마가 있으면 그 그룹은 건너뛰고 이름을 알린다", () => {
    const { themes, report } = importWatchlistGroups([theme("a", "반도체", ["1"])], list([{ name: "반도체", symbols: ["005930"] }, { name: "지주", symbols: [] }]), ids());
    expect(themes).toEqual([theme("a", "반도체", ["1"]), theme("new-1", "지주")]);
    expect(report.sameName).toEqual(["반도체"]);
    expect(importNotices("히트맵", 2, report)).toEqual(["‘히트맵’ 목록에서 테마 1개를 가져왔습니다.", "이름이 같은 테마가 이미 있어 건너뜀: 반도체"]);
  });
  it("같은 목록에서 이름이 겹치는 두 그룹은 앞의 것만 가져온다", () => {
    const { themes, report } = importWatchlistGroups([], list([{ name: "반도체", symbols: ["1"] }, { name: "반도체", symbols: ["2"] }]), ids());
    expect(themes).toEqual([theme("new-1", "반도체", ["1"])]);
    expect(report.sameName).toEqual(["반도체"]);
  });
  it("종목이 60개를 넘으면 앞의 60개만 넣고 알린다", () => {
    const { themes, report } = importWatchlistGroups([], list([{ name: "많음", symbols: codes(75) }]), ids());
    expect(themes[0]!.symbols).toEqual(codes(60));
    expect(report.truncated).toEqual([{ name: "많음", kept: 60, total: 75 }]);
    expect(importNotices("히트맵", 1, report)).toContain("‘많음’ 그룹은 종목이 75개라 앞의 60개만 넣었습니다.");
  });
  it("지수는 빼고 알리며 지수를 뺀 뒤의 앞 60개를 넣는다", () => {
    const { themes, report } = importWatchlistGroups([], list([{ name: "섞임", symbols: ["IDX:001", ...codes(61), "IDX:101"] }]), ids());
    expect(themes[0]!.symbols).toEqual(codes(60));
    expect(report.indexDropped).toEqual([{ name: "섞임", count: 2 }]);
    expect(importNotices("히트맵", 1, report)).toContain("‘섞임’ 그룹의 지수 2개는 뺐습니다.");
  });
  it("그룹 안 중복 종목은 하나로 합친다", () => {
    const { themes } = importWatchlistGroups([], list([{ name: "겹침", symbols: ["1", "2", "1"] }]), ids());
    expect(themes[0]!.symbols).toEqual(["1", "2"]);
  });
  it("그룹 이름의 앞뒤 공백은 다듬고 비었거나 40자를 넘으면 건너뛴다", () => {
    const { themes, report } = importWatchlistGroups([], list([{ name: " 공백 ", symbols: [] }, { name: "  ", symbols: [] }, { name: "가".repeat(41), symbols: [] }]), ids());
    expect(themes.map((t) => t.name)).toEqual(["공백"]);
    expect(report.invalidName).toHaveLength(2);
  });
  it("테마가 100개가 되면 나머지는 건너뛴다", () => {
    const existing = Array.from({ length: MAX_THEMES - 1 }, (_, i) => theme(`t${i}`, `이름${i}`));
    const { themes, report } = importWatchlistGroups(existing, list([{ name: "하나", symbols: [] }, { name: "둘", symbols: [] }]), ids());
    expect(themes).toHaveLength(MAX_THEMES);
    expect(report.overThemeLimit).toEqual(["둘"]);
  });
  it("그룹이 없는 목록은 가져올 테마가 없다고 알린다", () => {
    const { themes, report } = importWatchlistGroups([theme("a", "기존")], list([]), ids());
    expect(themes).toEqual([theme("a", "기존")]);
    expect(importNotices("빈 목록", 0, report)).toEqual(["‘빈 목록’ 목록에는 그룹이 없어 가져올 테마가 없습니다."]);
  });
  it("관심종목 목록을 바꾸지 않는다", () => {
    const source = list([{ name: "반도체", symbols: ["005930", "IDX:001"] }]);
    const before = structuredClone(source);
    importWatchlistGroups([], source, ids());
    expect(source).toEqual(before);
  });
});
