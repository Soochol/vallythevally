// @vitest-environment happy-dom
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { TradingExecution } from "../../api/generated/TradingExecution";
import type { ViPlaybook } from "../../api/generated/ViPlaybook";
import { windowId } from "../../layout/kinds";
import { useLayoutStore } from "../../stores/layout";
import { marketSocket } from "../../stores/realtime";
import { useUiStore } from "../../stores/ui";
import { renderWithProviders } from "../../test/domHarness";
import { resetDomAfterEach } from "../../test/domSetup";
import { OrderWindow } from "./OrderWindow";
import { ORDER_SOUND_LABEL } from "./orderSettings";
import { ACCOUNT, BASE, CODE, setupOrderEnv } from "./orderTestHarness";

const PLAYBOOK: ViPlaybook = {
  symbol: CODE,
  direction: "up",
  kind: "all",
  lookbackDays: 42,
  sampleCount: 6,
  horizons: [
    { minutes: 1, samples: 6, winRatePct: 66.67, avgReturnPct: 1.45, avgMaePct: -0.62 },
    { minutes: 3, samples: 6, winRatePct: 50.0, avgReturnPct: 1.12, avgMaePct: -1.18 },
    { minutes: 5, samples: 6, winRatePct: 66.67, avgReturnPct: 2.34, avgMaePct: -1.45 },
  ],
  recentMatches: [
    { date: "2026-11-23", triggeredAt: "09:14:00", releasedAt: "09:16:02", kind: "dynamic", triggerPrice: 76_800, releasePrice: 77_000, return1mPct: 1.82, return3mPct: 2.45, return5mPct: 3.1, return10mPct: 4.2, mae5mPct: -0.5, lateDropDetected: false },
  ],
};

function stubAudio() {
  const started: { frequencies: number[]; type: OscillatorType }[] = [];
  class FakeAudioContext {
    state: AudioContextState = "running";
    currentTime = 1;
    destination = {};
    resume = vi.fn(() => Promise.resolve());
    createOscillator() {
      const frequencies: number[] = [];
      const osc = {
        type: "sine" as OscillatorType,
        frequency: {
          value: 440,
          setValueAtTime: (v: number) => { frequencies.push(v); },
        },
        connect: vi.fn(),
        disconnect: vi.fn(),
        start: () => { started.push({ frequencies: frequencies.length ? [...frequencies] : [osc.frequency.value], type: osc.type }); },
        stop: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      };
      return osc;
    }
    createGain() {
      return {
        gain: { value: 1, setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
        connect: vi.fn(),
        disconnect: vi.fn(),
      };
    }
  }
  vi.stubGlobal("AudioContext", FakeAudioContext);
  return started;
}

afterEach(() => {
  marketSocket.stop();
});

resetDomAfterEach();

test("VI 오버레이와 플레이북 팝오버, NXT 실시간 체결의 호가주문 요약·보유손익(%) 반영 및 창 닫힘 후 수량 초기화", async () => {
  const env = setupOrderEnv({
    playbook: PLAYBOOK,
    holdings: [{ code: CODE, name: "삼성전자", quantity: 120, sellableQuantity: 120, averagePrice: 70_040, currentPrice: BASE, evaluationProfit: -4_800, profitRateCenti: -57 }],
  });

  const { client, unmount } = renderWithProviders(<OrderWindow id={windowId("order")} />);
  await screen.findByTestId("price-ladder");
  await waitFor(() => expect(screen.getByTestId("summary-profit").textContent).toContain("−4,800원"));

  await act(async () => {
    await Promise.resolve();
    env.socket.emit({ type: "vi_snapshot", states: [] });
    for (const sub of env.socket.subsOf("trades", CODE)) {
      env.socket.emit({ type: "feed_trades", sub, seq: 1, trades: [{ t: 1_794_186_005, price: 70_500, qty: 1_000, venue: "nxt", strength: 101.5 }] });
    }
    env.socket.emit({
      type: "vi_update",
      state: { symbol: CODE, market: "krx", active: true, direction: "up", triggerPrice: 77_000, base: 70_000, triggeredAt: 1_794_185_980, releasedAt: null },
    });
  });

  expect(screen.getByTestId("summary-profit").textContent).toContain("+55,200원");
  fireEvent.click(screen.getByTestId("summary-profit"));
  expect(screen.getByTestId("summary-profit").textContent).toContain("+0.14%");

  const playbookTrigger = await screen.findByTestId("order-vi-card-1");
  fireEvent.click(playbookTrigger);
  expect((await screen.findByTestId("order-vi-popover")).textContent).toContain("+1.45%");

  const qty = screen.getByRole("textbox", { name: "수량" }) as HTMLInputElement;
  fireEvent.change(qty, { target: { value: "37" } });
  expect(qty.value).toBe("37");
  unmount();

  useUiStore.getState().takeOrderWindow(useLayoutStore.getState().layout.id, windowId("order"));
  const reopened = renderWithProviders(<OrderWindow id={windowId("order")} />);
  expect(((await reopened.findByRole("textbox", { name: "수량" })) as HTMLInputElement).value).toBe("10");
  reopened.client.clear();
  client.clear();
});

test("매수·매도 접수·실시간 체결 소리 및 음소거 토글 동작과 거부 시 무음", async () => {
  const tones = stubAudio();
  const env = setupOrderEnv({
    holdings: [{ code: CODE, name: "삼성전자", quantity: 100, sellableQuantity: 100, averagePrice: BASE, currentPrice: BASE, evaluationProfit: 0, profitRateCenti: 0 }],
  });
  const { client } = renderWithProviders(<OrderWindow id={windowId("order")} />);
  await screen.findByTestId("price-ladder");
  await waitFor(() => expect(screen.getByTestId("order-window").hasAttribute("data-writable")).toBe(true));

  fireEvent.dblClick(document.querySelector(`[data-order-cell][data-side="buy"][data-price="${BASE}"]`)!);
  await waitFor(() => expect(tones.length).toBeGreaterThanOrEqual(1));
  const buyToneCount = tones.length;

  fireEvent.dblClick(document.querySelector(`[data-order-cell][data-side="sell"][data-price="${BASE + 100}"]`)!);
  await waitFor(() => expect(tones.length).toBeGreaterThan(buyToneCount));
  const afterSell = tones.length;

  env.placeReply = { state: "rejected", reason: "buy_over_buying_power", orderNo: null };
  fireEvent.dblClick(document.querySelector(`[data-order-cell][data-side="buy"][data-price="${BASE}"]`)!);
  await waitFor(() => expect(screen.getByTestId("order-status").textContent).toContain("매수 가능 금액"));
  expect(tones).toHaveLength(afterSell);

  fireEvent.click(screen.getByTestId("order-settings-button"));
  const soundCheck = within(await screen.findByTestId("order-settings")).getByRole("checkbox", { name: new RegExp(ORDER_SOUND_LABEL) });
  fireEvent.click(soundCheck);
  await act(async () => {
    env.socket.emit({
      type: "trading_account_changed",
      accountRef: ACCOUNT,
      fill: { orderNo: "fill-1", quantity: 5, cumulativeQuantity: 5 },
    });
  });
  expect(tones).toHaveLength(afterSell);
  client.clear();
});

test("내 체결 탭은 포렌식 조회와 진단 뱃지 없이 체결 내역만 표시한다", async () => {
  const fill1: TradingExecution = { orderNo: "0001001", code: CODE, name: "삼성전자", side: "buy", quantity: 10, price: BASE, time: "091500", venue: "krx" };
  const env = setupOrderEnv({
    executions: [fill1],
    forensics: {
      date: "20261109",
      account: ACCOUNT,
      items: [
        { orderNo: "0001001", code: CODE, name: "삼성전자", side: "buy", time: "091500", fillAt: 1_794_186_000, price: BASE, quantity: 10, collected: true, diagnosis: "iceberg_support", mfePct: 1.15, maePct: -0.1, slippageTicks: 0, preEntryCancelRatePct: 0, programDeltaMillionWon: 85, whaleNetDeltaMillionWon: 40, summary: "아이스버그 지지 포착" },
      ],
    },
  });

  const { client } = renderWithProviders(<OrderWindow id={windowId("order")} />);
  await screen.findByTestId("price-ladder");
  await waitFor(() => expect(screen.getByTestId("order-window").hasAttribute("data-writable")).toBe(true));

  fireEvent.click(screen.getByTestId("account-tab-fills"));
  const fills = await screen.findAllByTestId("account-fill");
  expect(fills).toHaveLength(1);
  expect(screen.queryByTestId("fill-diagnosis-badge")).toBeNull();
  expect(screen.queryByTestId("execution-forensic-card")).toBeNull();
  expect(env.forensicsCalls()).toBe(0);
  client.clear();
});
