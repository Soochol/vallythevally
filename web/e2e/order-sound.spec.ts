import type { Page } from "@playwright/test";
import type { TradingExecution } from "../src/api/generated/TradingExecution";
import { ORDER_SOUND_LABEL } from "../src/features/order/orderSettings";
import { ORDER_SOUND_TONES, type OrderSoundKind } from "../src/features/order/orderSound";
import { expect, pollSaved, test } from "./harness";
import { ACCOUNT, type Api, CODE, cellAt, center, chipAt, dragChip, openOrder, openOrderWindow, ordersOn, status, tradingApi, win, writesTo } from "./order-window";

interface RecordedOscillator {
  readonly frequencies: readonly number[];
  readonly type: OscillatorType;
}

const executionCount = (api: Api): number => api.seen.filter((seen) => seen.path === "/api/trading/executions").length;

const expectedTones = (kind: OrderSoundKind): readonly RecordedOscillator[] =>
  ORDER_SOUND_TONES[kind].map((step) => ({ frequencies: [step.frequency], type: step.type }));

const fill = (orderNo: string, quantity: number, side: "buy" | "sell" = "buy", time = "093000"): TradingExecution => ({
  orderNo,
  code: CODE,
  name: "삼성전자",
  side,
  quantity,
  price: 70_000,
  time,
  venue: "krx",
});

async function installAudioRecorder(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const recorded: { frequencies: number[]; type: OscillatorType }[] = [];
    (window as unknown as Record<string, unknown>).__orderSoundTones = recorded;
    const host = window as unknown as {
      AudioContext?: new () => AudioContext;
      webkitAudioContext?: new () => AudioContext;
    };
    const Native = host.AudioContext ?? host.webkitAudioContext;
    if (typeof Native !== "function") return;
    function WrappedAudioContext() {
      const ctx = new Native!();
      const nativeCreateOscillator = ctx.createOscillator.bind(ctx);
      ctx.createOscillator = () => {
        const osc = nativeCreateOscillator();
        const frequencies: number[] = [];
        const nativeSetValue = osc.frequency.setValueAtTime.bind(osc.frequency);
        osc.frequency.setValueAtTime = (value: number, startTime: number) => {
          frequencies.push(value);
          return nativeSetValue(value, startTime);
        };
        const nativeStart = osc.start.bind(osc);
        osc.start = (when?: number) => {
          recorded.push({ frequencies: frequencies.length > 0 ? [...frequencies] : [osc.frequency.value], type: osc.type });
          return nativeStart(when);
        };
        return osc;
      };
      return ctx;
    }
    const wrapped = WrappedAudioContext as unknown as new () => AudioContext;
    host.AudioContext = wrapped;
    if (host.webkitAudioContext) host.webkitAudioContext = wrapped;
  });
}

const readRecorded = (page: Page): Promise<RecordedOscillator[]> =>
  page.evaluate(() => ((window as unknown as Record<string, unknown>).__orderSoundTones as RecordedOscillator[] | undefined) ?? []);

const clearRecorded = (page: Page): Promise<void> =>
  page.evaluate(() => {
    const list = (window as unknown as Record<string, unknown>).__orderSoundTones as RecordedOscillator[] | undefined;
    if (list) list.length = 0;
  });

const waitExecutionsResponse = (page: Page) => page.waitForResponse((response) => new URL(response.url()).pathname === "/api/trading/executions");

const soundCheckbox = (page: Page) => page.getByTestId("order-settings").getByRole("checkbox", { name: new RegExp(ORDER_SOUND_LABEL) });

test("매수·매도 접수마다 서로 다른 소리가 나고 거부·확인필요·정정·취소에는 울리지 않는다", async ({ page, scenario }) => {
  await installAudioRecorder(page);
  ordersOn(scenario);
  const api = tradingApi(scenario, [openOrder("0000001", "buy", 69_900, 5)]);
  await openOrderWindow(page, scenario);

  await cellAt(page, "buy", 70_000).dblclick();
  await expect(status(page)).toContainText("접수 · 매수 10 · 70,000원");
  await expect.poll(() => readRecorded(page)).toEqual(expectedTones("buy-accepted"));

  await clearRecorded(page);
  await cellAt(page, "sell", 70_100).dblclick();
  await expect(status(page)).toContainText("접수 · 매도 10 · 70,100원");
  await expect.poll(() => readRecorded(page)).toEqual(expectedTones("sell-accepted"));
  expect(expectedTones("buy-accepted")).not.toEqual(expectedTones("sell-accepted"));

  await clearRecorded(page);
  api.placeReply = { state: "rejected", reason: "kiwoom_rejected", orderNo: null };
  await cellAt(page, "buy", 69_800).dblclick();
  await expect(status(page)).toContainText("거절 · 키움이 주문을 거절했습니다");
  expect(writesTo(api, "place")).toHaveLength(3);
  expect(await readRecorded(page)).toEqual([]);

  await dragChip(page, chipAt(page, "buy", 69_900), await center(cellAt(page, "buy", 69_700)));
  await expect(status(page)).toContainText("접수 · 정정");
  expect(writesTo(api, "modify")).toHaveLength(1);
  expect(await readRecorded(page)).toEqual([]);

  await page.getByTestId("account-tab-open").click();
  await page.getByTestId("account-open-order").first().getByRole("button", { name: "취소" }).click();
  await expect(status(page)).toContainText("접수 · 취소");
  expect(writesTo(api, "cancel")).toHaveLength(1);
  await page.keyboard.press("Escape");
  expect(await readRecorded(page)).toEqual([]);

  api.placeReply = { state: "unknown", reason: null, orderNo: null };
  await cellAt(page, "sell", 70_200).dblclick();
  await expect(status(page)).toContainText("결과를 확인하지 못했습니다");
  expect(writesTo(api, "place")).toHaveLength(4);
  expect(await readRecorded(page)).toEqual([]);
});

test("초기 체결은 울리지 않고 새 체결·부분 체결 증가에만 체결 소리가 나며 창 둘에서도 한 번만 울린다", async ({ page, scenario }) => {
  await installAudioRecorder(page);
  ordersOn(scenario);
  const api = tradingApi(scenario);
  api.executions = [fill("0000001", 5, "buy", "093000")];
  await openOrderWindow(page, scenario);

  await pollSaved(() => executionCount(api)).toBeGreaterThanOrEqual(1);
  await page.getByTestId("account-tab-fills").click();
  await expect(page.getByTestId("account-fill")).toHaveCount(1);
  await page.keyboard.press("Escape");
  expect(await readRecorded(page)).toEqual([]);

  const beforeNewFill = executionCount(api);
  api.executions = [fill("0000001", 5, "buy", "093000"), fill("0000002", 3, "sell", "093100")];
  scenario.live.emit({ type: "trading_account_changed", accountRef: ACCOUNT });
  await pollSaved(() => executionCount(api)).toBeGreaterThan(beforeNewFill);
  await expect.poll(() => readRecorded(page)).toEqual(expectedTones("filled"));

  await clearRecorded(page);
  const unchangedReply = waitExecutionsResponse(page);
  scenario.live.emit({ type: "trading_account_changed", accountRef: ACCOUNT });
  await unchangedReply;
  await page.getByTestId("account-tab-fills").click();
  await expect(page.getByTestId("account-fill")).toHaveCount(2);
  await page.keyboard.press("Escape");
  expect(await readRecorded(page)).toEqual([]);

  const beforePartial = executionCount(api);
  api.executions = [fill("0000001", 5, "buy", "093000"), fill("0000002", 8, "sell", "093105")];
  scenario.live.emit({ type: "trading_account_changed", accountRef: ACCOUNT });
  await pollSaved(() => executionCount(api)).toBeGreaterThan(beforePartial);
  await expect.poll(() => readRecorded(page)).toEqual(expectedTones("filled"));

  await clearRecorded(page);
  await page.getByRole("tab", { name: /^호가주문/ }).click({ button: "right" });
  await page.getByRole("menu", { name: "창 배치" }).getByRole("menuitem", { name: "복제" }).click();
  await expect(page.getByRole("tabpanel", { name: "호가주문 2" }).getByTestId("order-window")).toBeVisible();

  const beforeTwoWindows = executionCount(api);
  api.executions = [fill("0000001", 5, "buy", "093000"), fill("0000002", 8, "sell", "093105"), fill("0000003", 4, "buy", "093200")];
  scenario.live.emit({ type: "trading_account_changed", accountRef: ACCOUNT });
  await pollSaved(() => executionCount(api)).toBeGreaterThan(beforeTwoWindows);
  await expect.poll(() => readRecorded(page)).toEqual(expectedTones("filled"));
});

test("주문 소리 설정은 기본 켜짐이고 끄면 새로고침 뒤에도 유지되며 음소거 중 체결은 다시 켜도 울리지 않는다", async ({ page, scenario }) => {
  await installAudioRecorder(page);
  ordersOn(scenario);
  const api = tradingApi(scenario);
  api.executions = [fill("0000001", 5, "buy", "093000")];
  await openOrderWindow(page, scenario);
  await pollSaved(() => executionCount(api)).toBeGreaterThanOrEqual(1);

  await page.getByTestId("order-settings-button").click();
  await expect(soundCheckbox(page)).toBeChecked();
  await soundCheckbox(page).uncheck();
  await pollSaved(() => scenario.documents.uiState()["orderSettings"]).toMatchObject({ sound: false });
  await page.keyboard.press("Escape");

  const beforeReload = executionCount(api);
  await page.reload();
  await expect(win(page)).toBeVisible();
  await pollSaved(() => executionCount(api)).toBeGreaterThan(beforeReload);
  await page.getByTestId("order-settings-button").click();
  await expect(soundCheckbox(page)).not.toBeChecked();
  await page.keyboard.press("Escape");

  await clearRecorded(page);
  await cellAt(page, "buy", 70_000).dblclick();
  await expect(status(page)).toContainText("접수 · 매수 10 · 70,000원");
  await cellAt(page, "sell", 70_100).dblclick();
  await expect(status(page)).toContainText("접수 · 매도 10 · 70,100원");

  const mutedFillReply = waitExecutionsResponse(page);
  api.executions = [fill("0000001", 5, "buy", "093000"), fill("0000002", 6, "buy", "093100")];
  scenario.live.emit({ type: "trading_account_changed", accountRef: ACCOUNT });
  await mutedFillReply;
  await page.getByTestId("account-tab-fills").click();
  await expect(page.getByTestId("account-fill")).toHaveCount(2);
  await page.keyboard.press("Escape");
  expect(await readRecorded(page)).toEqual([]);

  await page.getByTestId("order-settings-button").click();
  await soundCheckbox(page).check();
  await pollSaved(() => scenario.documents.uiState()["orderSettings"]).toMatchObject({ sound: true });
  await page.keyboard.press("Escape");

  const afterUnmuteReply = waitExecutionsResponse(page);
  scenario.live.emit({ type: "trading_account_changed", accountRef: ACCOUNT });
  await afterUnmuteReply;
  await page.getByTestId("account-tab-fills").click();
  await expect(page.getByTestId("account-fill")).toHaveCount(2);
  await page.keyboard.press("Escape");
  expect(await readRecorded(page)).toEqual([]);

  const beforeNextFill = executionCount(api);
  api.executions = [fill("0000001", 5, "buy", "093000"), fill("0000002", 6, "buy", "093100"), fill("0000003", 2, "sell", "093200")];
  scenario.live.emit({ type: "trading_account_changed", accountRef: ACCOUNT });
  await pollSaved(() => executionCount(api)).toBeGreaterThan(beforeNextFill);
  await expect.poll(() => readRecorded(page)).toEqual(expectedTones("filled"));
});
