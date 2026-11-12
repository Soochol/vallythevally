import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { DEFAULT_LAYOUT, useLayoutStore } from "../../stores/layout";
import { IndicatorCommandBody } from "./IndicatorCommand";

function markup(mode: "indicators" | "compare") {
  useLayoutStore.getState().load(structuredClone(DEFAULT_LAYOUT));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const html = renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(IndicatorCommandBody, { slot: 0, initialMode: mode })));
  client.clear();
  return html;
}

test("입력창에는 현재 지표·추가 후보·공유 설정 양식과 입력 경계가 함께 있다", () => {
  const html = markup("indicators");
  expect(html).toContain("지표·비교 입력창");
  expect(html).toContain('role="combobox"');
  expect(html).toContain('aria-label="지표·비교 찾기"');
  expect(html).toContain('aria-label="거래량 설정"');
  expect(html).toContain('aria-label="거래량 숨기기"');
  expect(html).toContain('aria-label="거래량 지우기"');
  expect(html).toContain('aria-label="이동평균 단순 20 추가 후보"');
  expect(html).toContain('aria-label="선 색상 선택"');
  expect(html).toContain('aria-label="굵기"');
  expect(html).toContain('data-chart-control=""');
  expect(html).toContain('data-command-frame=""');
  expect(html).toContain("700px");
  expect(html).toContain("Shift+Enter");
  expect(html).not.toContain('role="tab"');
});

test("비교 호출도 같은 입력창 틀에서 비교 수·가격축·추가 동작을 보인다", () => {
  const html = markup("compare");
  expect(html).toContain("지표·비교 입력창");
  expect(html).toContain("비교 종목 0/3");
  expect(html).toContain("가격축을 % 변화로");
  expect(html).toContain("비교 종목 추가");
  expect(html).toContain('data-chart-control=""');
});
