// @vitest-environment happy-dom
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, test } from "vitest";
import type { AutoOrderRule } from "../../api/generated/AutoOrderRule";
import { useServerModeStore } from "../../public-mode/serverMode";
import { useAutoOrdersStore } from "../../stores/autoOrders";
import { installDomShims, resetDomAfterEach } from "../../test/domSetup";
import { AutoGuardBadge } from "./AutoGuardBadge";

const SAMPLE_RULE: AutoOrderRule = {
  id: "rule-1",
  symbol: "005930",
  name: "삼성전자",
  accountRef: "acc-1",
  entryPrice: 70_000,
  quantity: 10,
  remainingQuantity: 10,
  stopLossPrice: 67_000,
  takeProfit1Price: 73_000,
  takeProfit2Price: 76_000,
  tp1Ratio: 50,
  breakevenOnTp1: false,
  trailingEnabled: false,
  trailingPct: 3,
  highWaterMark: 70_000,
  orderType: "market",
  tickOffset: 0,
  state: "watching",
  tp1Done: false,
  commandId: null,
  updatedAt: 1_764_200_000,
};

beforeEach(() => {
  installDomShims();
  useServerModeStore.setState({ kind: "local" });
  useAutoOrdersStore.setState({
    loaded: true,
    masterEnabled: true,
    rules: [SAMPLE_RULE],
    events: [],
  });
});

resetDomAfterEach();

test("AutoGuardBadge는 Top Layer Popover와 유효한 토큰·한국장 SL/TP 색으로 열린다", () => {
  render(<AutoGuardBadge />);

  fireEvent.click(screen.getByTestId("auto-guard-badge"));
  const dialog = screen.getByRole("dialog", { name: "자동감시 종목 목록" });
  expect(dialog.getAttribute("popover")).toBe("manual");
  expect(dialog.className).toContain("border-line");
  expect(dialog.className).not.toContain("border-border");
  expect(dialog.innerHTML).not.toContain("bg-surface-2");

  const sl = screen.getByText(/SL 67,000/);
  const tp = screen.getByText(/TP 76,000/);
  expect(sl.className).toContain("text-down");
  expect(tp.className).toContain("text-up");
});
