import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { DrawingDetails } from "./DrawingDetails";
import { DrawingToolbar } from "./DrawingToolbar";
import { toolsByGroup } from "../../chart/drawings/tools";
import { hlineDefaults } from "../../chart/drawings/tools/hline";
import type { Tool } from "../../chart/drawings/toolSpec";
import type { DrawingBody } from "../../chart/drawings/types";

const defaults = hlineDefaults();
const drawing: DrawingBody = { id: "line", symbol: "005930", tool: "hline", points: [{ t: 1, price: 100 }], text: null, style: { ...defaults, line: { ...defaults.line, color: "#123456" }, label: { ...defaults.label, color: "#123456" } }, locked: false, hidden: false, periods: null, z: 1, group: null, scope: { kind: "symbol" }, revision: 1 };

const GROUP_LABEL: Record<Tool["group"], string> = { line: "선", fib: "피보나치", shape: "도형", note: "주석", measure: "측정" };

test("드로잉 막대는 도구가 둘 이상인 그룹에만 펼침 버튼을 두고 전체 개체 조작은 없다", () => {
  const html = renderToStaticMarkup(createElement(DrawingToolbar));
  expect(html).toContain("data-chart-control");
  for (const [group, label] of Object.entries(GROUP_LABEL) as [Tool["group"], string][]) {
    const toggle = `aria-label="${label} 도구 펼치기"`;
    if ((toolsByGroup().get(group)?.length ?? 0) > 1) expect(html).toContain(toggle);
    else expect(html).not.toContain(toggle);
  }
  expect(html).not.toContain("모든 드로잉 잠그기");
  expect(html).not.toContain("모든 드로잉 숨기기");
  expect(html).not.toContain("이 종목 드로잉 모두 지우기");
});

test("작은 막대의 팝오버는 모달 없이 기존 글자·좌표·주기와 전체 스타일을 제공한다", () => {
  const html = renderToStaticMarkup(createElement(DrawingDetails, { slot: 0, editor: { kind: "settings", original: drawing, draft: drawing }, anchor: { current: null } }));
  expect(html).toContain("data-chart-control");
  expect(html).not.toContain('aria-modal="true"');
  for (const label of ["수평선 세부 설정", "선 색 선택", "선 굵기", "선 모양", "가격 라벨", "글자 모양", "가로 정렬", "세로 정렬", "점 1 가격", "모든 봉 주기", "기본 스타일로"]) expect(html).toContain(label);
  expect(html).not.toContain('type="datetime-local"');
});
