// @vitest-environment happy-dom
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { marketSocket } from "../../stores/realtime";
import { windowId } from "../../layout/kinds";
import { useUiStore } from "../../stores/ui";
import { renderWithProviders } from "../../test/domHarness";
import { resetDomAfterEach } from "../../test/domSetup";
import { OrderWindow } from "./OrderWindow";
import { BASE, CODE, openOrder, setupOrderEnv } from "./orderTestHarness";

afterEach(() => {
  marketSocket.stop();
});

resetDomAfterEach();

test("매수 가능 칸과 자금 팝오버에서 미수 허용 확인·취소·전환 실패 복구·증거금률 100% 제한·미수금 경고를 검증한다", async () => {
  const env = setupOrderEnv({ orderable: { cashAmount: 500_000_000, marginAmount: 1_500_000_000, unpaid: 1_000_000 } });
  const { client, unmount } = renderWithProviders(<OrderWindow id={windowId("order")} />);

  const buyable = await screen.findByTestId("summary-buyable");
  await waitFor(() => expect(buyable.getAttribute("data-policy")).toBe("cash_only"));
  expect(buyable.getAttribute("aria-label")).toBe("매수 가능 · 현금");
  expect(buyable.textContent).toContain("현금");
  expect(buyable.textContent).toContain("500,000,000원");
  expect(buyable.getAttribute("data-unpaid")).toBe("1000000");
  expect(screen.getByTestId("margin-policy").textContent).toBe("현금");

  fireEvent.click(buyable);
  const panel = await screen.findByTestId("funds-panel");
  expect(panel.textContent).toContain("예수금520,000,000원");
  expect(panel.textContent).toContain("적용 100%");
  expect(screen.getByTestId("funds-unpaid")).toBeTruthy();

  fireEvent.click(within(panel).getByRole("button", { name: "미수 허용" }));
  expect(screen.getByTestId("margin-confirm").textContent).toContain("반대매매");
  expect(env.policyWrites()).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "그대로 두기" }));
  expect(screen.queryByTestId("margin-confirm")).toBeNull();
  expect(env.policyWrites()).toHaveLength(0);

  env.policyFailMessage = "정책 저장 거절";
  fireEvent.click(within(panel).getByRole("button", { name: "미수 허용" }));
  fireEvent.click(screen.getByRole("button", { name: "허용으로 바꾸기" }));
  expect((await within(panel).findByRole("alert")).textContent).toContain("정책 저장 거절");
  expect(screen.getByTestId("margin-toggle").getAttribute("data-policy")).toBe("cash_only");

  env.policyFailMessage = null;
  fireEvent.click(within(panel).getByRole("button", { name: "미수 허용" }));
  fireEvent.click(screen.getByRole("button", { name: "허용으로 바꾸기" }));
  await waitFor(() => expect(buyable.getAttribute("data-policy")).toBe("allow_margin"));
  expect(buyable.textContent).toContain("1,500,000,000원");
  expect(screen.getByTestId("margin-policy").textContent).toBe("미수 허용");

  client.clear();
  unmount();

  setupOrderEnv({ orderable: { accountRate: 100, appliedRate: 100, marginAmount: null, marginQuantity: null } });
  const restricted = renderWithProviders(<OrderWindow id={windowId("order")} />);
  const restrictedBuyable = await screen.findByTestId("summary-buyable");
  await waitFor(() => expect(restrictedBuyable.getAttribute("data-policy")).toBe("cash_only"));
  fireEvent.click(restrictedBuyable);
  const toggleBtn = (await screen.findByTestId("funds-margin")) as HTMLButtonElement;
  expect(toggleBtn.disabled).toBe(true);
  restricted.client.clear();
  restricted.unmount();

  const failedEnv = setupOrderEnv();
  failedEnv.buyableFailMessage = "조회 실패";
  const failedBuyable = renderWithProviders(<OrderWindow id={windowId("order")} />);
  const errBuyable = await failedBuyable.findByTestId("summary-buyable");
  await waitFor(() => expect(errBuyable.textContent).toContain("-"));
  failedBuyable.client.clear();
});

test("매수 비율 토글 모드(입력 수량 유지·호버 가격별 미리보기·1회 주문 후 자동 해제·입력 시 즉시 해제)와 매도 고정 프리셋을 검증한다", async () => {
  const env = setupOrderEnv({
    orderable: { cashAmount: 7_000_000, cashQuantity: 100, marginAmount: 14_000_000, marginQuantity: 200 },
    holdings: [{ code: CODE, name: "삼성전자", quantity: 120, sellableQuantity: 120, averagePrice: BASE, currentPrice: BASE, evaluationProfit: 0, profitRateCenti: 0 }],
    openOrders: [openOrder("0000001", "sell", BASE + 500, 50)],
  });

  const { client, unmount } = renderWithProviders(<OrderWindow id={windowId("order")} />);
  const row = await screen.findByTestId("order-quantity-row");
  const modeGroup = within(row).getByRole("group", { name: "프리셋 기준" });
  const qtyInput = screen.getByRole("textbox", { name: "수량" }) as HTMLInputElement;

  fireEvent.change(qtyInput, { target: { value: "15", selectionStart: 2 } });
  expect(qtyInput.value).toBe("15");

  fireEvent.click(within(modeGroup).getByRole("button", { name: "매수" }));
  const buyPresets = within(row).getByRole("group", { name: "매수 비율 프리셋" });
  const btn50 = within(buyPresets).getByRole("button", { name: "50%" }) as HTMLButtonElement;
  const btnFull = within(buyPresets).getByRole("button", { name: "전량" }) as HTMLButtonElement;
  await waitFor(() => expect(btn50.disabled).toBe(false));
  expect(within(buyPresets).getAllByRole("button").map((b) => b.textContent)).toEqual(["25%", "50%", "75%", "전량"]);
  expect(useUiStore.getState().prefs.orderSettings.presetMode).toBe("buy");
  expect(btn50.getAttribute("aria-pressed")).toBe("false");
  expect(qtyInput.hasAttribute("data-ratio-active")).toBe(false);

  fireEvent.click(btn50);
  expect(qtyInput.value).toBe("15");
  expect(qtyInput.hasAttribute("data-ratio-active")).toBe(true);
  expect(btn50.getAttribute("aria-pressed")).toBe("true");
  expect(btn50.hasAttribute("data-picked")).toBe(true);

  await waitFor(() => expect(screen.getByTestId("order-window").hasAttribute("data-writable")).toBe(true));

  const cellAtBase = document.querySelector(`[data-order-cell][data-side="buy"][data-price="${BASE}"]`)!;
  const cellAtHigher = document.querySelector(`[data-order-cell][data-side="buy"][data-price="${BASE + 100}"]`)!;

  fireEvent.pointerEnter(cellAtBase);
  expect(within(cellAtBase as HTMLElement).getByTestId("order-preview").textContent).toBe("매수 50");
  fireEvent.pointerLeave(cellAtBase);

  fireEvent.pointerEnter(cellAtHigher);
  expect(within(cellAtHigher as HTMLElement).getByTestId("order-preview").textContent).toBe("매수 49");
  fireEvent.pointerLeave(cellAtHigher);

  fireEvent.click(btn50);
  expect(btn50.getAttribute("aria-pressed")).toBe("false");
  expect(qtyInput.hasAttribute("data-ratio-active")).toBe(false);
  expect(qtyInput.value).toBe("15");

  fireEvent.click(btnFull);
  expect(btnFull.getAttribute("aria-pressed")).toBe("true");
  expect(qtyInput.hasAttribute("data-ratio-active")).toBe(true);
  expect(qtyInput.value).toBe("15");

  fireEvent.pointerEnter(cellAtHigher);
  expect(within(cellAtHigher as HTMLElement).getByTestId("order-preview").textContent).toBe("매수 99");
  fireEvent.pointerLeave(cellAtHigher);

  fireEvent.dblClick(cellAtHigher);
  await waitFor(() => expect(env.placedBodies()).toHaveLength(1));
  expect(env.placedBodies()[0]).toMatchObject({ side: "buy", price: BASE + 100, quantity: 99 });
  expect(btnFull.getAttribute("aria-pressed")).toBe("false");
  expect(qtyInput.hasAttribute("data-ratio-active")).toBe(false);
  expect(qtyInput.value).toBe("15");

  fireEvent.dblClick(cellAtBase);
  await waitFor(() => expect(env.placedBodies()).toHaveLength(2));
  expect(env.placedBodies()[1]).toMatchObject({ side: "buy", price: BASE, quantity: 15 });

  fireEvent.click(btn50);
  expect(btn50.getAttribute("aria-pressed")).toBe("true");
  fireEvent.change(qtyInput, { target: { value: "5", selectionStart: 1 } });
  expect(btn50.getAttribute("aria-pressed")).toBe("false");
  expect(qtyInput.hasAttribute("data-ratio-active")).toBe(false);
  expect(qtyInput.value).toBe("5");

  fireEvent.click(btn50);
  expect(btn50.getAttribute("aria-pressed")).toBe("true");
  fireEvent.keyDown(qtyInput, { key: "5" });
  expect(btn50.getAttribute("aria-pressed")).toBe("false");
  expect(qtyInput.hasAttribute("data-ratio-active")).toBe(false);

  fireEvent.click(within(modeGroup).getByRole("button", { name: "매도" }));
  const sellPresets = within(row).getByRole("group", { name: "매도 비율 프리셋" });
  const sell25 = within(sellPresets).getByRole("button", { name: "25%" });
  expect(sell25.getAttribute("aria-pressed")).toBeNull();
  fireEvent.click(sell25);
  expect(qtyInput.value).toBe("17");
  fireEvent.click(within(sellPresets).getByRole("button", { name: "전량" }));
  expect(qtyInput.value).toBe("70");
  client.clear();
  unmount();

  setupOrderEnv({
    orderable: { cashAmount: 0, cashQuantity: 0, marginAmount: 0, marginQuantity: 0 },
    holdings: [{ code: CODE, name: "삼성전자", quantity: 3, sellableQuantity: 3, averagePrice: BASE, currentPrice: BASE, evaluationProfit: 0, profitRateCenti: 0 }],
  });
  const smallView = renderWithProviders(<OrderWindow id={windowId("order")} />);
  const smallRow = await smallView.findByTestId("order-quantity-row");
  fireEvent.click(within(smallRow).getByRole("button", { name: "매도" }));
  const btns = within(within(smallRow).getByRole("group", { name: "매도 비율 프리셋" })).getAllByRole("button") as HTMLButtonElement[];
  await waitFor(() => expect(btns[1]!.disabled).toBe(false));
  expect(btns[0]!.disabled).toBe(true);
  fireEvent.click(btns[1]!);
  expect((smallView.getByRole("textbox", { name: "수량" }) as HTMLInputElement).value).toBe("1");
  smallView.client.clear();
});
