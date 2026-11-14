import { expect, test } from "vitest";
import type { Placement, Tool } from "../toolSpec";
import { type DrawingTool, type PointCount, TOOL_POINTS } from "../types";
import { MODES } from "../modes";
import { TOOLS, toolOf, toolsByGroup } from "./index";

function countOf(p: Placement): PointCount {
  switch (p.kind) {
    case "points":
      return { kind: "exact", n: p.count };
    case "polyline":
    case "freehand":
      return { kind: "range", min: p.min, max: p.max };
  }
}

test.each(TOOLS.map((t) => [t.tool, t] as const))("%s의 점 수는 서버 표(§5.3)와 같다", (id, tool) => {
  expect(countOf(tool.placement)).toEqual(TOOL_POINTS[id]);
});

test("서버 표는 도구 36개다", () => {
  expect(Object.keys(TOOL_POINTS)).toHaveLength(36);
});

const FINAL_TABLE: readonly (readonly [Tool["group"], readonly (readonly [DrawingTool, string])[]])[] = [
  ["line", [["trendline", "추세선"], ["ray", "반직선"], ["extline", "연장선"], ["hline", "수평선"], ["hray", "수평 반직선"], ["vline", "수직선"], ["crossline", "십자선"], ["channel", "평행 채널"], ["regression", "회귀 채널"], ["pitchfork", "피치포크"]]],
  ["fib", [["fib", "피보나치 되돌림"], ["fibext", "피보나치 확장"], ["fibfan", "피보나치 팬"], ["fibtime", "피보나치 시간대"], ["gannfan", "갠 팬"], ["gannbox", "갠 상자"]]],
  ["shape", [["rect", "사각형"], ["ellipse", "타원"], ["triangle", "삼각형"], ["path", "꺾은선"], ["brush", "붓"]]],
  ["note", [["text", "글자"], ["callout", "말풍선"], ["pricelabel", "가격 라벨"], ["arrow", "화살표"]]],
  ["measure", [["pricerange", "가격 범위"], ["daterange", "날짜 범위"], ["datepricerange", "날짜·가격 범위"], ["long", "매수 포지션"], ["short", "매도 포지션"], ["avwap", "기준봉 VWAP"], ["volprofile", "구간 거래량 프로파일"]]],
  ["pattern", [["elliott", "엘리엇 충격 파동"], ["elliottabc", "엘리엇 조정 파동"], ["xabcd", "XABCD 패턴"], ["headshoulders", "헤드앤숄더"]]],
];

test("최종 도구 표는 서버 표의 도구를 한 번씩 담는다", () => {
  expect(FINAL_TABLE.flatMap(([, tools]) => tools.map(([id]) => id)).sort()).toEqual(Object.keys(TOOL_POINTS).sort());
});

test("등록 표는 최종 도구 표와 그룹·순서·이름까지 같다", () => {
  expect([...toolsByGroup()].map(([group, tools]) => [group, tools.map((t) => [t.tool, t.label])])).toEqual(FINAL_TABLE);
});

test("서버 표의 도구는 모두 등록돼 있다", () => {
  expect(TOOLS.map((t) => t.tool).sort()).toEqual(Object.keys(TOOL_POINTS).sort());
  for (const id of Object.keys(TOOL_POINTS) as DrawingTool[]) expect(toolOf(id), id).toBeDefined();
});

test("모드는 지우개와 시연 커서다", () => {
  expect(MODES.map((mode) => [mode.id, mode.label])).toEqual([["eraser", "지우개"], ["demo", "시연 커서"]]);
});

test("등록 표에 같은 도구가 두 번 없다", () => {
  const ids = TOOLS.map((t) => t.tool);
  expect(new Set(ids).size).toBe(ids.length);
  for (const t of TOOLS) expect(toolOf(t.tool)).toBe(t);
});

test("모든 도구의 기본 스타일은 parseStyle을 거쳐도 같다", () => {
  for (const t of TOOLS) expect(t.parseStyle(t.defaultStyle())).toEqual(t.defaultStyle());
});

const GROUP_ORDER: readonly Tool["group"][] = ["line", "fib", "shape", "note", "measure", "pattern"];
const GROUP_FILES = import.meta.glob<Record<string, unknown>>(["./groups/**/*.{ts,tsx}", "!./groups/**/*.test.{ts,tsx}"], { eager: true });
const fileGroup = (path: string) => path.slice("./groups/".length).replace(/\.tsx?$/, "");
const toolsOfFile = (path: string): readonly Tool[] => {
  const name = `${fileGroup(path).toUpperCase()}_TOOLS`;
  const exports = GROUP_FILES[path]!;
  expect(Object.keys(exports), `${path}는 ${name} 하나만 내보낸다`).toEqual([name]);
  expect(exports[name], `${path}의 ${name}`).toBeInstanceOf(Array);
  return exports[name] as readonly Tool[];
};

test("그룹 파일마다 그 이름의 그룹 도구만 들어 있다", () => {
  expect(Object.keys(GROUP_FILES).map(fileGroup).sort()).toEqual([...GROUP_ORDER].sort());
  for (const path of Object.keys(GROUP_FILES)) {
    for (const t of toolsOfFile(path)) expect(t.group, `${path}의 ${t.tool}`).toBe(fileGroup(path));
  }
});

test("등록 표는 선, 피보나치·갠, 도형, 주석, 측정, 패턴 그룹 순서로 이어진다", () => {
  const expected = GROUP_ORDER.flatMap((group) => toolsOfFile(`./groups/${group}.ts`));
  expect(TOOLS).toEqual(expected);
});
