// @vitest-environment happy-dom
import { fireEvent, screen, within } from "@testing-library/react";
import { createRef } from "react";
import { beforeEach, expect, test } from "vitest";
import { chartWindows, DEFAULT_LAYOUT, useLayoutStore } from "../../stores/layout";
import { useSelectionStore } from "../../stores/selection";
import { renderWithProviders, stubFetch } from "../../test/domHarness";
import { resetDomAfterEach } from "../../test/domSetup";
import { ChartRightDock } from "./ChartRightDock";

const firstCellId = () => chartWindows(DEFAULT_LAYOUT)[0]!.id;

function makeHostRef(width = 960) {
  const host = document.createElement("div");
  Object.defineProperty(host, "clientWidth", { value: width, configurable: true });
  const hostRef = createRef<HTMLElement | null>();
  hostRef.current = host;
  return hostRef;
}

beforeEach(() => {
  stubFetch(() => ({ body: [] }));
  useLayoutStore.getState().load(structuredClone(DEFAULT_LAYOUT));
  const cellId = firstCellId();
  useLayoutStore.getState().addIndicator(cellId, { kind: "ma", method: "sma", period: 20 }, { colors: ["ind-1"], width: 1 }, "price");
  useLayoutStore.getState().addIndicator(cellId, { kind: "rsi", period: 14, signal: null }, { colors: ["ind-2"], width: 1 }, "panel");
  useSelectionStore.setState({
    activeCell: cellId,
    dialog: null,
    chartDock: { cellId, mode: "current", indicatorId: null, snapped: true },
    toasts: [],
    toast: null,
  });
});

resetDomAfterEach();

test("우측 레이어 목록을 유지한 채 좌측 상세 플라이아웃을 즉시 전환·토글 닫기할 수 있다", () => {
  const cellId = firstCellId();
  const { client } = renderWithProviders(<ChartRightDock cellId={cellId} hostRef={makeHostRef()} />, { withToast: false });

  expect(screen.queryByRole("region", { name: "지표 상세 설정" })).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "거래량 설정" }));
  const detail = screen.getByRole("region", { name: "지표 상세 설정" });
  expect(within(detail).getByRole("heading", { name: "거래량" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "RSI 14 설정" })).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "RSI 14 설정" }));
  expect(within(screen.getByRole("region", { name: "지표 상세 설정" })).getByRole("heading", { name: "RSI" })).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "이동평균 묶음 설정" }));
  expect(within(screen.getByRole("region", { name: "지표 상세 설정" })).getByRole("heading", { name: "이동평균선" })).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "이동평균 묶음 설정" }));
  expect(screen.queryByRole("region", { name: "지표 상세 설정" })).toBeNull();
  client.clear();
});

test("퀵 추가 바에서 텍스트 입력 Enter와 이평선 기간 칩으로 지표를 즉시 추가할 수 있다", () => {
  const cellId = firstCellId();
  const { client } = renderWithProviders(<ChartRightDock cellId={cellId} hostRef={makeHostRef()} />, { withToast: false });

  const input = screen.getByRole("combobox", { name: "지표 빠른 추가" });
  fireEvent.focus(input);
  fireEvent.click(screen.getByRole("button", { name: "60" }));
  expect(
    chartWindows(useLayoutStore.getState().layout)[0]!.chartSettings.indicators.filter((i) => i.spec.kind === "ma").map((i) => i.spec),
  ).toEqual([
    { kind: "ma", method: "sma", period: 20 },
    { kind: "ma", method: "sma", period: 60 },
  ]);

  fireEvent.change(input, { target: { value: "bb 20 2" } });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(
    chartWindows(useLayoutStore.getState().layout)[0]!.chartSettings.indicators.some((i) => i.spec.kind === "bollinger"),
  ).toBe(true);
  expect(within(screen.getByRole("region", { name: "지표 상세 설정" })).getByRole("heading", { name: "볼린저 밴드" })).toBeTruthy();
  client.clear();
});

test("우측 도킹 상단 탭은 레이어 · 드로잉 · 차트 순서이고 피크/고정 전환과 패널 병합·정리를 지원한다", () => {
  const cellId = firstCellId();
  const { client } = renderWithProviders(<ChartRightDock cellId={cellId} hostRef={makeHostRef()} />, { withToast: false });

  const seg = screen.getByRole("group", { name: "차트 설정 영역" });
  const buttons = Array.from(seg.querySelectorAll("button"));
  expect(buttons.map((b) => b.textContent)).toEqual(["레이어", "드로잉", "차트"]);
  expect(buttons[2]?.getAttribute("aria-label")).toBe("차트 설정");

  fireEvent.click(screen.getByRole("button", { name: "글래스 피크로 전환" }));
  expect(useSelectionStore.getState().chartDock?.snapped).toBe(false);

  fireEvent.click(screen.getByRole("button", { name: "RSI 14 위 패널에 합치기" }));
  expect(chartWindows(useLayoutStore.getState().layout)[0]!.chartSettings.panels).toHaveLength(1);

  fireEvent.click(screen.getByRole("button", { name: "RSI 14 숨기기" }));
  fireEvent.click(screen.getByRole("button", { name: "레이어 정리 메뉴" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "숨긴 지표 모두 삭제 (1)" }));
  expect(chartWindows(useLayoutStore.getState().layout)[0]!.chartSettings.indicators.some((i) => i.spec.kind === "rsi")).toBe(false);
  expect(useSelectionStore.getState().toast?.undo).toBeTruthy();

  useSelectionStore.getState().toast?.undo?.run();
  expect(chartWindows(useLayoutStore.getState().layout)[0]!.chartSettings.indicators.some((i) => i.spec.kind === "rsi")).toBe(true);
  client.clear();
});

test("좁은 차트 폭에서는 모달로 튕기지 않고 글래스 피크 오버레이로 동작한다", () => {
  const cellId = firstCellId();
  const { client } = renderWithProviders(<ChartRightDock cellId={cellId} hostRef={makeHostRef(480)} />, { withToast: false });

  expect(useSelectionStore.getState().dialog).toBeNull();
  const snapButton = screen.getByRole("button", { name: "우측 고정 도킹" }) as HTMLButtonElement;
  expect(snapButton.disabled).toBe(true);
  client.clear();
});
