// @vitest-environment happy-dom
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { windowId } from "../../layout/kinds";
import { marketSocket } from "../../stores/realtime";
import { renderWithProviders } from "../../test/domHarness";
import { resetDomAfterEach } from "../../test/domSetup";
import { BookWindow } from "../book/BookWindow";
import { OrderWindow } from "../order/OrderWindow";
import { BASE, CODE, setupOrderEnv } from "../order/orderTestHarness";

afterEach(() => {
  vi.useRealTimers();
  marketSocket.stop();
});

resetDomAfterEach();

const infoSlotEl = (label: string) =>
  screen.getAllByTestId("ladder-info").find((el) => el.getAttribute("data-label") === label);

test("정보란 칸 클릭·Enter·Space 뒤집기, 종목 탭 왕복 유지 및 거래량↔동시간비 유지", async () => {
  const env = setupOrderEnv();
  const { client } = renderWithProviders(<OrderWindow id={windowId("order")} />);
  await screen.findByTestId("price-ladder");

  const openSlot = await waitFor(() => {
    const el = infoSlotEl("시가");
    expect(el).toBeTruthy();
    return el!;
  });
  expect(openSlot.textContent).toContain("69,900");
  fireEvent.click(openSlot);
  const openRate = await waitFor(() => {
    const el = infoSlotEl("시가 등락");
    expect(el).toBeTruthy();
    return el!;
  });
  expect(openRate.textContent).toContain("−0.14%");

  fireEvent.click(screen.getByRole("tab", { name: "종목" }));
  await waitFor(() => expect(infoSlotEl("상한가")).toBeTruthy());
  fireEvent.click(screen.getByRole("tab", { name: "시세" }));
  expect(infoSlotEl("시가 등락")?.textContent).toContain("−0.14%");

  fireEvent.click(infoSlotEl("시가 등락")!);
  await waitFor(() => expect(infoSlotEl("시가")).toBeTruthy());

  fireEvent.click(infoSlotEl("거래량")!);
  expect(infoSlotEl("동시간비")?.textContent).toContain("-");

  await waitFor(() => expect(env.socket.subsOf("trades", CODE).length).toBeGreaterThan(0));
  await act(async () => {
    for (const sub of env.socket.subsOf("trades", CODE)) {
      env.socket.emit({
        type: "feed_trades",
        sub,
        seq: 1,
        trades: [{ t: 1_794_186_001, price: BASE, qty: 3, venue: "krx", strength: 101.5, sameTimeRatio: 93.95 }],
      });
    }
  });
  await waitFor(() => expect(infoSlotEl("동시간비")?.textContent).toContain("93.95%"));

  await act(async () => {
    for (const sub of env.socket.subsOf("trades", CODE)) {
      env.socket.emit({
        type: "feed_trades",
        sub,
        seq: 2,
        trades: [{ t: 1_794_186_002, price: BASE, qty: 2, venue: "krx", strength: 101.5 }],
      });
    }
  });
  expect(infoSlotEl("동시간비")?.textContent).toContain("93.95%");
  client.clear();
});

test("정규장 VI 발동 시 예상체결 두 칸과 사다리 강조가 보이고 해제 뒤 KRX 분봉 기준가로 VI 가격을 계산하며 장외는 숨긴다", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const regMs = Date.parse("2026-11-09T10:00:00+09:00");
  vi.setSystemTime(regMs);
  const regSec = Math.floor(regMs / 1000);

  const env = setupOrderEnv();
  const view1 = renderWithProviders(<BookWindow id={windowId("book")} />);
  await screen.findByTestId("price-ladder");
  await waitFor(() => expect(env.socket.subsOf("book", CODE).length).toBeGreaterThan(0));

  await act(async () => {
    env.socket.emit({ type: "vi_snapshot", states: [] });
    for (const sub of env.socket.subsOf("book", CODE)) {
      env.socket.emit({
        type: "feed_book",
        sub,
        book: { t: regSec, asks: [{ price: BASE + 100, qty: 50 }], bids: [{ price: BASE, qty: 80 }], totalAskQty: 50, totalBidQty: 80, expected: { price: BASE + 100, qty: 300 } },
      });
    }
  });
  expect(infoSlotEl("예상체결가")).toBeUndefined();

  await act(async () => {
    env.socket.emit({
      type: "vi_update",
      state: { symbol: CODE, market: "krx", active: true, direction: "up", triggerPrice: 77_100, base: 70_000, triggeredAt: regSec - 30, releasedAt: null },
    });
  });

  await waitFor(() => expect(infoSlotEl("예상체결가")?.textContent).toContain("70,100"));
  expect(infoSlotEl("예상체결량")?.textContent).toContain("300");

  await act(async () => {
    env.socket.emit({
      type: "vi_update",
      state: { symbol: CODE, market: "krx", active: false, direction: "up", triggerPrice: 77_100, base: null, triggeredAt: regSec - 600, releasedAt: regSec - 466 },
    });
  });
  await waitFor(() => expect(infoSlotEl("예상체결가")).toBeUndefined());
  view1.client.clear();
  view1.unmount();

  const offMs = Date.parse("2026-11-09T07:30:00+09:00");
  vi.setSystemTime(offMs);
  const offEnv = setupOrderEnv();
  const offView = renderWithProviders(<BookWindow id={windowId("book")} />);
  await offView.findByTestId("price-ladder");
  fireEvent.click(offView.getByRole("tab", { name: "종목" }));
  await waitFor(() => expect(infoSlotEl("상승VI")?.textContent).toContain("-"));
  expect(infoSlotEl("하락VI")?.textContent).toContain("-");
  expect(offEnv.daySummaryCalls("krx")).toBe(0);
  offView.client.clear();
  offView.unmount();
});
