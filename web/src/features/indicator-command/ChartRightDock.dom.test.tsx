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

test("우측 도킹은 통합 트리에서 자식 인스턴스 편집과 부모 클릭 새 인스턴스 추가를 지원한다", () => {
  const cellId = firstCellId();
  const host = document.createElement("div");
  Object.defineProperty(host, "clientWidth", { value: 900, configurable: true });
  const hostRef = createRef<HTMLElement | null>();
  hostRef.current = host;

  const { client } = renderWithProviders(<ChartRightDock cellId={cellId} hostRef={hostRef} />, { withToast: false });

  expect(screen.queryByRole("tab")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "이동평균 단순 20 설정" }));

  expect(screen.getByRole("heading", { name: "이동평균" })).toBeTruthy();
  expect((screen.getByRole("textbox", { name: "기간" }) as HTMLInputElement).value).toBe("20");

  fireEvent.click(screen.getByRole("button", { name: "← 지표 목록" }));
  fireEvent.click(screen.getByRole("button", { name: "이동평균 단순 20 추가 후보" }));

  expect(screen.getByText("새 인스턴스 #2")).toBeTruthy();
  expect(screen.getByRole("button", { name: "이동평균 단순 20 추가" })).toBeTruthy();
  client.clear();
});
