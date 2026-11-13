import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { DEFAULT_LAYOUT, useLayoutStore } from "../../stores/layout";
import { useSelectionStore, type IndicatorCommandMode } from "../../stores/selection";
import { IndicatorCommandBody } from "./IndicatorCommand";

function markup(mode: IndicatorCommandMode) {
  useLayoutStore.getState().load(structuredClone(DEFAULT_LAYOUT));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const html = renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(IndicatorCommandBody, { slot: 0, initialMode: mode })));
  client.clear();
  return html;
}

test("지표 창은 세 탭과 띄운 지표 목록, 공유 설정 양식, 입력 경계를 함께 보인다", () => {
  const html = markup("current");
  expect(html).toContain("지표·비교 입력창");
  expect(html).toContain('role="combobox"');
  expect(html).toContain('aria-label="지표·비교 찾기"');
  expect(html.match(/role="tab"/g)).toHaveLength(3);
  for (const label of ["이 칸에 띄운 지표", "지표 추가", "비교 종목"]) expect(html).toContain(label);
  expect(html).toContain('aria-label="거래량 설정"');
  expect(html).toContain('aria-label="거래량 숨기기"');
  expect(html).toContain('aria-label="거래량 지우기"');
  expect(html).toContain("아래 패널");
  expect(html).toContain("변경 적용");
  expect(html).toContain('data-chart-control=""');
  expect(html).toContain('data-command-frame=""');
  expect(html).toContain("976px");
  expect(html).toContain("300px");
  expect(html).toContain("Shift+Enter");
});

test("지표 추가 탭은 종류별 묶음에 추가 후보를 두고 추가 버튼을 보인다", () => {
  const html = markup("add");
  expect(html).toContain('aria-label="이동평균 단순 20 추가 후보"');
  for (const group of ["가격 패널", "아래 패널", "재무지표"]) expect(html).toContain(group);
  expect(html).toContain("이동평균 단순 20 추가");
  expect(html).toContain('aria-label="선 미리보기"');
  expect(html).toContain('aria-label="굵기"');
  expect(html).toContain('aria-label="테마 색"');
  expect(html).toContain('aria-label="색상표"');
  expect(html).toContain("직접 고르기");
  expect(html).not.toContain('aria-label="거래량 숨기기"');
});

test("비교 종목 탭은 같은 틀에서 비교 수·가격축·추가 동작을 보인다", () => {
  const html = markup("compare");
  expect(html).toContain("지표·비교 입력창");
  expect(html).toContain("비교 종목 0/3");
  expect(html).toContain("가격축을 % 변화로");
  expect(html).toContain("비교 종목 추가");
  expect(html).toContain('data-chart-control=""');
});

test("모드 없이 열면 띄운 지표가 있을 때 띄운 지표 탭, 없을 때 지표 추가 탭이다", () => {
  useLayoutStore.getState().load(structuredClone(DEFAULT_LAYOUT));
  useSelectionStore.getState().openIndicatorCommand(0);
  expect(useSelectionStore.getState().dialog).toEqual({ kind: "indicatorCommand", slot: 0, mode: "current" });
  for (const config of useLayoutStore.getState().layout.cells[0]!.chartSettings.indicators) useLayoutStore.getState().removeIndicator(0, config.id);
  useSelectionStore.getState().openIndicatorCommand(0);
  expect(useSelectionStore.getState().dialog).toMatchObject({ mode: "add" });
  useSelectionStore.getState().openIndicatorCommand(0, "compare");
  expect(useSelectionStore.getState().dialog).toMatchObject({ mode: "compare" });
  useSelectionStore.getState().closeDialog();
});
