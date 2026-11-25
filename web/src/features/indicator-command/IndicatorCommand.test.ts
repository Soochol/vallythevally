import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { chartWindows, DEFAULT_LAYOUT, useLayoutStore } from "../../stores/layout";
import type { IndicatorCommandMode } from "../../stores/selection";
import { IndicatorCommandBody } from "./IndicatorCommand";

function markup(mode: IndicatorCommandMode) {
  useLayoutStore.getState().load(structuredClone(DEFAULT_LAYOUT));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const html = renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(IndicatorCommandBody, { cellId: chartWindows(DEFAULT_LAYOUT)[0]!.id, initialMode: mode })));
  client.clear();
  return html;
}

test("지표 창은 세 탭과 띄운 지표 목록, 공유 설정 양식, 입력 경계를 가운데 창으로 보인다", () => {
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
  expect(html).not.toContain("변경 적용");
  expect(html).toContain('data-chart-control=""');
  expect(html).toContain('data-command-frame=""');
  expect(html).toContain("ic-frame");
  expect(html).toContain('data-solid=""');
  expect(html).not.toContain('data-placement="top-end"');
  expect(html).toContain("되돌리고 닫기");
  expect(html.match(/<footer/g)).toHaveLength(1);
});

test("지표 추가 탭은 종류별 묶음에 추가 후보를 두고 하단 추가 버튼 없이 자동 저장 안내를 보인다", () => {
  const html = markup("add");
  expect(html).toContain('aria-label="이동평균 단순 20 추가 후보"');
  for (const group of ["가격 패널", "아래 패널", "재무지표"]) expect(html).toContain(group);
  expect(html).not.toContain("btn-primary");
  expect(html).toContain('aria-label="선 미리보기"');
  expect(html).toContain('aria-label="굵기"');
  expect(html).toContain('aria-label="테마 색"');
  expect(html).toContain('aria-label="색상표"');
  expect(html).toContain("직접 고르기");
  expect(html).not.toContain('aria-label="거래량 숨기기"');
});

test("비교 종목 탭은 같은 틀에서 비교 수·가격축을 보이고 하단 추가 버튼은 두지 않는다", () => {
  const html = markup("compare");
  expect(html).toContain("지표·비교 입력창");
  expect(html).toContain("비교 종목 0/3");
  expect(html).toContain("가격축을 % 변화로");
  expect(html).not.toContain("비교 종목 추가");
  expect(html).not.toContain("<kbd class=\"ui-kbd \">Tab</kbd>");
  expect(html).toContain('data-chart-control=""');
});
