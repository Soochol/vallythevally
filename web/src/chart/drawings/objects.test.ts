import { expect, test } from "vitest";
import { windowId } from "../../layout/kinds";
import { copy, paste } from "./clipboard";
import { objectGroups, objectName, renameObject, reusableStyle, defaultObjectStyle } from "./objects";
import { hline } from "./tools/hline";
import { trendline } from "./tools/trendline";
import type { DrawingBody } from "./types";

const drawing: DrawingBody = { id: "line", symbol: "005930", tool: "hline", points: [{ t: 1, price: 100 }], text: "차트 글자", style: { future: 7 }, locked: false, hidden: false, periods: null, z: 1, group: null, scope: { kind: "symbol" }, revision: 1 };

test("이름은 글자·스타일을 보존하고 도구 스타일 파싱과 복사·붙여넣기 뒤에도 남는다", () => {
  const renamed = renameObject(drawing, "  지지선  ");
  expect(objectName(renamed)).toBe("지지선");
  expect(renamed).toMatchObject({ text: "차트 글자", style: { objectName: "지지선", future: 7 } });
  for (const tool of [hline, trendline]) expect(tool.parseStyle(renamed.style)).toMatchObject({ objectName: "지지선", future: 7 });
  const clip = copy([renamed], drawing.symbol);
  expect(clip).not.toBeNull();
  if (!clip) throw new Error("복사할 드로잉이 필요합니다");
  const result = paste(clip, { symbol: "000660", scope: { kind: "symbol" }, topZ: 3, newId: () => "copy", shiftBars: (t) => t });
  expect(result.bodies[0]).toMatchObject({ id: "copy", symbol: "000660", style: { objectName: "지지선", future: 7 }, text: "차트 글자" });
});

test("이름이 없거나 잘못된 값이면 글자나 도구 이름을 쓴다", () => {
  for (const style of [null, {}, { objectName: 5 }, { objectName: " " }]) expect(objectName({ ...drawing, style })).toBe("차트 글자");
  expect(objectName({ ...drawing, text: null })).toBe("수평선");
});

test("기본 스타일로 되돌려도 개체 이름은 남고 새 드로잉용 스타일에서는 이름만 뺀다", () => {
  const renamed = renameObject(drawing, "지지선");
  expect(defaultObjectStyle(renamed)).toMatchObject({ objectName: "지지선", line: { width: 2, dash: "solid" } });
  expect(reusableStyle(hline.bar.width?.set(renamed.style, 5))).toMatchObject({ line: { width: 5 }, future: 7 });
  expect(reusableStyle(renamed.style)).toEqual({ future: 7 });
});

test("현재 종목 목록을 실제 범위로 묶고 다른 칸·레이아웃은 제외하며 z 내림차순을 지킨다", () => {
  const rows: DrawingBody[] = [drawing,
    { ...drawing, id: "cell", scope: { kind: "cell", layoutId: "L", windowId: "cell-0" }, z: 5 },
    { ...drawing, id: "layout", scope: { kind: "layout", layoutId: "L" } },
    { ...drawing, id: "other-cell", scope: { kind: "cell", layoutId: "L", windowId: "cell-1" } },
    { ...drawing, id: "other-layout", scope: { kind: "layout", layoutId: "other" } },
    { ...drawing, id: "top", z: 10, hidden: true },
  ];
  expect(objectGroups(rows, "L", windowId("cell-0")).map((g) => ({ label: g.label, ids: g.drawings.map((d) => d.id) }))).toEqual([
    { label: "이 칸", ids: ["cell"] }, { label: "이 레이아웃 공통", ids: ["layout"] }, { label: "이 종목 모든 칸 공통", ids: ["top", "line"] },
  ]);
  expect(objectGroups([], "L", windowId("cell-0"))).toEqual([]);
  expect(rows[0]?.id).toBe("line");
});
