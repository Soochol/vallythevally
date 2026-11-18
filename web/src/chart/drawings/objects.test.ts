import { expect, test } from "vitest";
import { copy, paste } from "./clipboard";
import { reusableStyle, defaultObjectStyle } from "./objects";
import { hline } from "./tools/hline";
import { trendline } from "./tools/trendline";
import type { DrawingBody } from "./types";

const drawing: DrawingBody = { id: "line", symbol: "005930", tool: "hline", points: [{ t: 1, price: 100 }], text: "차트 글자", style: { future: 7 }, locked: false, hidden: false, periods: null, z: 1, group: null, scope: { kind: "symbol" }, revision: 1 };
const named: DrawingBody = { ...drawing, style: { ...(drawing.style as object), objectName: "지지선" } };

test("저장된 이름은 글자·스타일을 보존하고 도구 스타일 파싱과 복사·붙여넣기 뒤에도 남는다", () => {
  for (const tool of [hline, trendline]) expect(tool.parseStyle(named.style)).toMatchObject({ objectName: "지지선", future: 7 });
  const clip = copy([named], drawing.symbol);
  expect(clip).not.toBeNull();
  if (!clip) throw new Error("복사할 드로잉이 필요합니다");
  const result = paste(clip, { symbol: "000660", scope: { kind: "symbol" }, topZ: 3, newId: () => "copy", shiftBars: (t) => t });
  expect(result.bodies[0]).toMatchObject({ id: "copy", symbol: "000660", style: { objectName: "지지선", future: 7 }, text: "차트 글자" });
});

test("기본 스타일로 되돌려도 저장된 이름은 남고 새 드로잉용 스타일에서는 이름만 뺀다", () => {
  expect(defaultObjectStyle(named)).toMatchObject({ objectName: "지지선", line: { width: 2, dash: "solid" } });
  expect(reusableStyle(hline.bar.width?.set(named.style, 5))).toMatchObject({ line: { width: 5 }, future: 7 });
  expect(reusableStyle(named.style)).toEqual({ future: 7 });
});
