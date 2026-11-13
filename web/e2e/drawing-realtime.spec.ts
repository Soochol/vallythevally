import { selectOption } from "./select-option";
import type { Page } from "@playwright/test";
import type { Drawing } from "../src/api/generated/Drawing";
import { type Scenario, cell, chartOf, expect, SEARCH_BUTTON_TITLE, test } from "./harness";

test.use({ clockStart: "20261109100000" });

interface Mirror {
  id: string;
  points: ({ x: number; y: number } | null)[];
}

async function mirror(page: Page): Promise<Mirror[]> {
  return JSON.parse(await chartOf(cell(page)).locator(".drawing-mirror").getAttribute("data-drawings") ?? "[]");
}

async function drawings(scenario: Scenario): Promise<Drawing[]> {
  return scenario.documents.drawings("005930");
}

async function pushPrice(scenario: Scenario, page: Page, price: number, _time: string) {
  await expect(async () => {
    const delivered = await scenario.live.update("005930", { c: Math.abs(Number(`+${price}`)), v: Math.abs(Number("1000")) });
    expect(delivered).toBeGreaterThan(0);
    await expect(chartOf(cell(page))).toHaveAttribute("data-last-close", String(price), { timeout: 1000 });
  }).toPass({ timeout: 15_000 });
}

async function chooseSymbol(page: Page, symbol: string) {
  await page.getByTitle(SEARCH_BUTTON_TITLE).click();
  const dialog = page.getByRole("dialog", { name: "종목 검색" });
  await dialog.getByRole("combobox", { name: "종목 검색" }).fill(symbol);
  await dialog.getByRole("option").filter({ hasText: symbol }).first().click();
  await expect(dialog).toBeHidden();
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
}

test("drawings survive realtime updates, series replacement, resync and controller disposal", async ({ page, scenario, context }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  let unsubscribes = 0;
  page.on("websocket", (socket) => socket.on("framesent", ({ payload }) => {
    if (JSON.parse(String(payload)).type === "unsubscribe") unsubscribes++;
  }));
  await page.goto("/?symbol=005930");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await expect.poll(async () => scenario.live.subscriptions().map(value => value.symbol)).toContain("005930");
  await pushPrice(scenario, page, 201_000, "100001");

  const chart = chartOf(cell(page));
  const box = (await chart.boundingBox())!;
  await cell(page).focus();
  await page.keyboard.press("T");
  await page.mouse.move(box.x + box.width * 0.76, box.y + box.height * 0.4);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.86, box.y + box.height * 0.3, { steps: 10 });
  await page.mouse.up();
  await expect.poll(() => drawings(scenario)).toHaveLength(1);
  const saved = (await drawings(scenario))[0]!;
  const expectDrawing = async (projected = true) => {
    await expect(chart.locator(".drawing-mirror")).toHaveCount(1);
    await expect.poll(() => mirror(page)).toEqual([
      { id: saved.id, tool: "trendline", selected: expect.any(Boolean),
        points: projected ? [expect.objectContaining({ x: expect.any(Number), y: expect.any(Number) }), expect.objectContaining({ x: expect.any(Number), y: expect.any(Number) })] : [null, null],
        handles: expect.any(Array) },
    ]);
    expect((await drawings(scenario))[0]!.points).toEqual(saved.points);
  };
  await expectDrawing();

  await page.getByRole("button", { name: "봉 모양", exact: true }).click();
  await page.getByRole("menuitemradio", { name: "라인", exact: true }).click();
  await pushPrice(scenario, page, 202_000, "100002");
  await expectDrawing();

  await selectOption(page.getByRole("button", { name: "분봉" }), "1m");
  await expect(cell(page)).toHaveAttribute("aria-label", "칸 1: 삼성전자 통합 1분");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await pushPrice(scenario, page, 203_000, "100003");
  await expectDrawing(false);
  await page.getByRole("group", { name: "봉 주기" }).getByRole("button", { name: "일", exact: true }).click();
  await expect(cell(page)).toHaveAttribute("aria-label", "칸 1: 삼성전자 통합 일");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await expectDrawing();

  scenario.live.status({ realtime: "reconnecting", since: Math.floor(scenario.now / 1000), backfilling: false });
  await expect(page.getByRole("contentinfo")).toContainText("키움에 다시 연결하는 중");
  scenario.live.status({ realtime: "live", since: Math.floor(scenario.now / 1000), backfilling: false });
  await expect(page.getByRole("contentinfo")).not.toContainText("다시 연결하는 중");
  await pushPrice(scenario, page, 204_000, "100004");
  await expectDrawing();

  await chooseSymbol(page, "005935");
  await expect.poll(() => mirror(page)).toEqual([]);
  await chooseSymbol(page, "005930");
  await pushPrice(scenario, page, 205_000, "100005");
  await expectDrawing();

  const cdp = await context.newCDPSession(page);
  const listenerTypes = async (expression: string) => {
    const { result } = await cdp.send("Runtime.evaluate", { expression });
    const { listeners } = await cdp.send("DOMDebugger.getEventListeners", { objectId: result.objectId! });
    return listeners.map((listener) => listener.type).filter((type) => ["keydown", "blur", "loadingdone"].includes(type)).sort();
  };
  const windowListeners = await listenerTypes("window");
  const fontListeners = await listenerTypes("document.fonts");
  const oldMirror = (await chart.locator(".drawing-mirror").elementHandle())!;
  const beforeDisposal = unsubscribes;
  await page.evaluate(() => {
    history.pushState(null, "", "/controller-remount");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await expect.poll(() => oldMirror.evaluate((element) => element.isConnected)).toBe(false);
  await expect(page).toHaveURL(/\/$/);
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await expect.poll(() => unsubscribes).toBeGreaterThan(beforeDisposal);
  await expectDrawing();
  const afterWindowListeners = await listenerTypes("window");
  const afterFontListeners = await listenerTypes("document.fonts");
  expect(afterWindowListeners).toEqual(windowListeners);
  expect(afterFontListeners).toEqual(fontListeners);
  await testInfo.attach("controller-disposal.json", {
    body: JSON.stringify({ windowListeners, afterWindowListeners, fontListeners, afterFontListeners, beforeDisposal, afterDisposal: unsubscribes, savedPoints: saved.points }),
    contentType: "application/json",
  });
  await cdp.detach();
  await pushPrice(scenario, page, 205_500, "100006");
  await expectDrawing();

  await page.reload();
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await pushPrice(scenario, page, 206_000, "100007");
  await expectDrawing();
  expect(errors).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("drawing-realtime.png") });
});
