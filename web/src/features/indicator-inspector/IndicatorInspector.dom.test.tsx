// @vitest-environment happy-dom
import { fireEvent, screen } from "@testing-library/react";
import { beforeEach, expect, test } from "vitest";
import { chartWindows, DEFAULT_LAYOUT, useLayoutStore } from "../../stores/layout";
import { useSelectionStore } from "../../stores/selection";
import { renderWithProviders, stubFetch } from "../../test/domHarness";
import { resetDomAfterEach } from "../../test/domSetup";
import { IndicatorInspector } from "./IndicatorInspector";

const firstCellId = () => chartWindows(DEFAULT_LAYOUT)[0]!.id;

beforeEach(() => {
  stubFetch(() => ({ body: [] }));
  useLayoutStore.getState().load(structuredClone(DEFAULT_LAYOUT));
  const cellId = firstCellId();
  useLayoutStore.getState().addIndicator(cellId, { kind: "ma", method: "sma", period: 20 }, { colors: ["ind-1"], width: 1 }, "price");
  useSelectionStore.setState({ activeCell: cellId, dialog: null, inspector: null, chartDock: null, toasts: [], toast: null });
});

resetDomAfterEach();

test("차트 옆 지표 창은 탭·필터 바 없이 카테고리별 부모→#1, #2 자식 트리로 통합되고 부모 추가·자식 편집·접기·비교 전환이 동작한다", () => {
  const { client } = renderWithProviders(<IndicatorInspector />, { withToast: false });

  expect(screen.queryByRole("tab")).toBeNull();
  expect(screen.queryByText("이 칸에 띄운 지표")).toBeNull();
  expect(screen.queryByRole("group", { name: "지표 분류" })).toBeNull();
  for (const group of ["가격 패널", "아래 패널", "호가지표", "재무지표"]) {
    expect(screen.getByText(group)).toBeTruthy();
  }

  fireEvent.click(screen.getByRole("button", { name: "이동평균 단순 20 설정" }));
  expect(screen.getByRole("group", { name: "이동평균 단순 20 설정" })).toBeTruthy();
  expect((screen.getByRole("textbox", { name: "기간" }) as HTMLInputElement).value).toBe("20");

  fireEvent.click(screen.getByRole("button", { name: "이동평균 인스턴스 접기" }));
  expect(screen.queryByRole("button", { name: "이동평균 단순 20 설정" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "이동평균 인스턴스 펼치기" }));
  expect(screen.getByRole("button", { name: "이동평균 단순 20 설정" })).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "이동평균 단순 20 추가 후보" }));
  expect(screen.getByText("새 인스턴스 #2")).toBeTruthy();
  expect(screen.getByRole("button", { name: "이동평균 단순 20 추가" })).toBeTruthy();

  const seg = screen.getByRole("group", { name: "지표 창 영역" });
  const compareBtn = seg.querySelectorAll("button")[1]!;
  fireEvent.click(compareBtn);
  expect(compareBtn.getAttribute("aria-pressed")).toBe("true");
  expect(screen.getByText("비교 종목 0/3")).toBeTruthy();
  client.clear();
});
