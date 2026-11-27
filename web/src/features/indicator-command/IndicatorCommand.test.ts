import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import type { IndicatorConfig } from "../../chart/settings";
import { chartWindows, DEFAULT_LAYOUT } from "../../stores/layout";
import type { IndicatorCommandMode } from "../../stores/selection";
import { MaGroupEditorView } from "../indicator-dialog/MaGroupEditor";
import { IndicatorCommandBody } from "./IndicatorCommand";

function markup(mode: IndicatorCommandMode) {
  const first = chartWindows(DEFAULT_LAYOUT)[0]!;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const html = renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(IndicatorCommandBody, { cellId: first.id, initialMode: mode })));
  client.clear();
  return html;
}

test("지표 창은 탭·필터 바 없이 카테고리별 지표 종류와 적용된 #1 자식을 통합 트리로 보인다", () => {
  const html = markup("current");
  expect(html).toContain("지표·비교 입력창");
  expect(html).toContain('role="combobox"');
  expect(html).toContain('aria-label="지표·비교 찾기"');
  expect(html).not.toContain('role="tab"');
  expect(html).not.toContain("이 칸에 띄운 지표");
  expect(html).not.toContain('aria-label="지표 분류"');
  expect(html).not.toContain("비교 종목");
  for (const group of ["가격 패널", "아래 패널", "호가지표", "재무지표"]) expect(html).toContain(group);
  expect(html).toContain('aria-label="이동평균 단순 20 추가 후보"');
  expect(html).toContain("#1");
  expect(html).toContain('aria-label="거래량 설정"');
  expect(html).toContain('aria-label="거래량 숨기기"');
  expect(html).toContain('aria-label="거래량 지우기"');
  expect(html).not.toContain("변경 적용");
  expect(html).toContain('data-chart-control=""');
  expect(html).toContain('data-command-frame=""');
  expect(html).toContain("ic-frame");
  expect(html).toContain('data-solid=""');
  expect(html).not.toContain('data-placement="top-end"');
  expect(html).toContain("되돌리고 닫기");
  expect(html.match(/<footer/g)).toHaveLength(1);
});

test("통합 이동평균선 편집기는 컬럼 헤더·구분·프리셋·빠른 추가·증감 버튼 없이 여러 선을 편집한다", () => {
  const first = chartWindows(DEFAULT_LAYOUT)[0]!;
  const indicators: IndicatorConfig[] = [
    { id: "ma-5", spec: { kind: "ma", method: "sma", period: 5 }, panel: "price", visible: true, style: { colors: ["ind-1"], width: 1 } },
    { id: "ma-20", spec: { kind: "ma", method: "ema", period: 20 }, panel: "price", visible: true, style: { colors: ["ind-2"], width: 2 } },
  ];
  const html = renderToStaticMarkup(createElement(MaGroupEditorView, { cellId: first.id, allIndicators: indicators }));
  expect(html).toContain("이동평균선 2/2");
  expect(html).toContain('aria-label="이동평균 단순 5 선 색 및 굵기 설정"');
  expect(html).toContain('aria-label="이동평균 단순 5 기간"');
  expect(html).toContain('aria-label="이동평균 지수 20 기간"');
  expect(html).toContain('aria-label="추가할 이동평균 기간"');
  expect(html).toContain("이동평균선 추가");
  expect(html).not.toContain("빠른 추가");
  expect(html).not.toContain("한국장");
  expect(html).not.toContain("초단기");
  expect(html).not.toContain("구분");
  expect(html).not.toContain("기간 (봉)");
});

test("추가 모드로 열면 첫 부모 후보의 새 인스턴스 미리보기와 추가 버튼을 보인다", () => {
  const html = markup("add");
  expect(html).not.toContain('role="tab"');
  expect(html).not.toContain('aria-label="지표 분류"');
  expect(html).toContain('aria-label="이동평균 단순 20 추가 후보"');
  expect(html).toContain("새 인스턴스 #1");
  expect(html).toContain("btn-primary");
  expect(html).toContain("이동평균 단순 20 추가");
  expect(html).toContain('aria-label="선 미리보기"');
  expect(html).toContain('aria-label="선 색 및 굵기 설정"');
});

test("비교 모드로 열면 탭 없이 비교 수·가격축을 보이고 하단 추가 버튼은 두지 않는다", () => {
  const html = markup("compare");
  expect(html).toContain("지표·비교 입력창");
  expect(html).not.toContain('role="tab"');
  expect(html).toContain("비교 종목 0/3");
  expect(html).toContain("가격축을 % 변화로");
  expect(html).not.toContain("비교 종목 추가");
  expect(html).not.toContain("<kbd class=\"ui-kbd \">Tab</kbd>");
  expect(html).toContain('data-chart-control=""');
});
