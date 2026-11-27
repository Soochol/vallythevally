// @vitest-environment happy-dom
import { fireEvent, screen } from "@testing-library/react";
import { createRef } from "react";
import { beforeEach, expect, test } from "vitest";
import { chartWindows, DEFAULT_LAYOUT, useLayoutStore } from "../../stores/layout";
import { useSelectionStore } from "../../stores/selection";
import { renderWithProviders, stubFetch } from "../../test/domHarness";
import { resetDomAfterEach } from "../../test/domSetup";
import { ChartRightDock } from "./ChartRightDock";

const firstCellId = () => chartWindows(DEFAULT_LAYOUT)[0]!.id;

beforeEach(() => {
  stubFetch(() => ({ body: [] }));
  useLayoutStore.getState().load(structuredClone(DEFAULT_LAYOUT));
  const cellId = firstCellId();
  useLayoutStore.getState().addIndicator(cellId, { kind: "ma", method: "sma", period: 20 }, { colors: ["ind-1"], width: 1 }, "price");
  useSelectionStore.setState({ activeCell: cellId, dialog: null, chartDock: { cellId, mode: "current", indicatorId: null }, toasts: [], toast: null });
});

resetDomAfterEach();

test("우측 도킹에서 이동평균선 그룹 세부 설정을 열어도 Maximum update depth exceeded 없이 렌더링되고 선 추가가 반영된다", () => {
  const cellId = firstCellId();
  const host = document.createElement("div");
  Object.defineProperty(host, "clientWidth", { value: 900, configurable: true });
  const hostRef = createRef<HTMLElement | null>();
  hostRef.current = host;

  const { client } = renderWithProviders(<ChartRightDock cellId={cellId} hostRef={hostRef} />, { withToast: false });

  fireEvent.click(screen.getByRole("button", { name: "이동평균선 (1)" }));

  expect(screen.getByRole("heading", { name: "이동평균선 (1)" })).toBeTruthy();
  expect(screen.getByRole("textbox", { name: "이동평균 단순 20 기간" })).toBeTruthy();

  fireEvent.change(screen.getByRole("textbox", { name: "추가할 이동평균 기간" }), { target: { value: "60" } });
  fireEvent.click(screen.getByRole("button", { name: "이동평균선 추가" }));

  expect(screen.getByRole("heading", { name: "이동평균선 (2)" })).toBeTruthy();
  expect(screen.getByRole("textbox", { name: "이동평균 단순 60 기간" })).toBeTruthy();
  client.clear();
});
