import type { Locator, Page } from "@playwright/test";
import type { Quote } from "../src/api/generated/Quote";
import { type Scenario, cell, expect, pollSaved, test } from "./harness";

test.use({ clockStart: "20261109100000", viewport: { width: 1440, height: 900 } });

const CODES = Array.from({ length: 20 }, (_, i) => String(950_000 + i * 10));
const panel = (page: Page) => page.getByRole("complementary", { name: "관심종목" });
const row = (page: Page, code: string) => panel(page).locator(`li[data-code="${code}"]`);
const quote = (code: string, price: number, change = 100, changeRate = 0.5): Quote => ({ symbol: code, price, change, changeRate, volume: 1000, t: 1794186000, source: "realtime", venue: "combined" });

interface Mutated { code: string | null; inCell: boolean }
interface RenderProbe {
  reset(): void;
  frames(): string[];
  mutations(): Mutated[];
}
declare global {
  interface Window { __renderProbe: RenderProbe }
}

async function installProbe(page: Page) {
  await page.addInitScript(() => {
    interface Fiber { tag: number; flags: number; child: Fiber | null; sibling: Fiber | null; alternate: Fiber | null; memoizedProps: Record<string, unknown> | null }
    const PERFORMED_WORK = 1;
    const COMPONENT_TAGS = new Set([0, 11, 15]);
    const HOST_COMPONENT = 5;
    let frames: string[] = [];
    let mutations: Mutated[] = [];
    const rowOf = (fiber: Fiber): string | null => {
      let host = fiber.child;
      while (host && host.tag !== HOST_COMPONENT) host = host.child;
      const key = host?.memoizedProps?.["data-row"];
      return typeof key === "string" ? key : null;
    };
    const walk = (next: Fiber, prev: Fiber | null) => {
      if (COMPONENT_TAGS.has(next.tag) && (next.flags & PERFORMED_WORK) !== 0) {
        const key = rowOf(next);
        if (key !== null) frames.push(key);
      }
      if (prev !== null && next.child === prev.child) return;
      for (let child = next.child; child; child = child.sibling) walk(child, child.alternate);
    };
    const hook = {
      supportsFiber: true,
      isDisabled: false,
      renderers: new Map(),
      inject: () => 1,
      checkDCE() {},
      onCommitFiberUnmount() {},
      onPostCommitFiberRoot() {},
      onCommitFiberRoot(_id: number, root: { current: Fiber }) { walk(root.current, root.current.alternate); },
    };
    Object.defineProperty(window, "__REACT_DEVTOOLS_GLOBAL_HOOK__", { value: hook, configurable: true });
    const collect = (records: MutationRecord[]) => {
      for (const record of records) {
        const target = record.target instanceof Element ? record.target : record.target.parentElement;
        if (target?.closest('aside[aria-label="관심종목"]') == null) continue;
        mutations.push({ code: target.closest("li[data-code]")?.getAttribute("data-code") ?? null, inCell: target.closest("[data-cell]") != null });
      }
    };
    const observer = new MutationObserver(collect);
    window.addEventListener("DOMContentLoaded", () => observer.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true }));
    window.__renderProbe = {
      reset() { frames = []; mutations = []; observer.takeRecords(); },
      frames: () => [...frames],
      mutations: () => { collect(observer.takeRecords()); return [...mutations]; },
    };
  });
}

const frames = (page: Page) => page.evaluate(() => window.__renderProbe.frames());
const mutations = (page: Page) => page.evaluate(() => window.__renderProbe.mutations());
const resetProbe = (page: Page) => page.evaluate(() => window.__renderProbe.reset());

async function openTwentyRows(page: Page, scenario: Scenario) {
  const current = scenario.documents.watchlists();
  scenario.documents.saveWatchlists({ lists: current.lists.map((list, i) => (i === 0 ? { ...list, symbols: CODES } : list)), revision: current.revision + 1 });
  CODES.forEach((code, i) => scenario.reply(`/api/symbols/${code}`, { body: { code, name: `합성${i}`, kind: "common", market: "kospi", nxtEnabled: false } }));
  scenario.reply("/api/quotes", { body: CODES.map((code, i) => quote(code, 10_000 + i * 100)) });
  await installProbe(page);
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await expect(panel(page).locator("li[data-code]")).toHaveCount(20);
  await expect(row(page, CODES[19]!)).toContainText("합성19");
  await expect(row(page, CODES[19]!)).toContainText("11,900");
  await pollSaved(() => scenario.live.messages.some((frame) => frame.type === "watch")).toBe(true);
}

const settle = (page: Page) => page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));

test("한 종목의 시세 프레임은 그 종목의 값 칸만 다시 그리고 줄 틀은 그리지 않는다", async ({ page, scenario }) => {
  await openTwentyRows(page, scenario);
  await resetProbe(page);
  scenario.live.emit({ type: "quotes", venue: "combined", quotes: [quote(CODES[7]!, 77_777, 700, 0.9)] });
  await expect(row(page, CODES[7]!)).toContainText("77,777");
  await settle(page);
  expect(await frames(page)).toHaveLength(0);
  const changed = await mutations(page);
  expect(changed.length).toBeGreaterThan(0);
  expect(changed.filter((m) => m.code !== CODES[7]! || !m.inCell)).toEqual([]);
});

test("한 종목의 VI는 그 종목 줄의 배지만 바꾸고 줄 틀은 그리지 않는다", async ({ page, scenario }) => {
  await openTwentyRows(page, scenario);
  await resetProbe(page);
  scenario.live.emit({ type: "vi_update", state: { symbol: CODES[7]!, market: "krx", active: true, direction: "up", triggerPrice: 11_800, base: 10_700, triggeredAt: 1794186000, releasedAt: null } });
  await expect(row(page, CODES[7]!).getByTestId("watch-vi")).toBeVisible();
  await settle(page);
  expect(await frames(page)).toHaveLength(0);
  const changed = await mutations(page);
  expect(changed.length).toBeGreaterThan(0);
  expect(changed.filter((m) => m.code !== CODES[7]! || m.inCell)).toEqual([]);
});

test("줄을 눌러 차트 종목을 바꾸면 이전·새 보는 종목의 줄 틀만 다시 그린다", async ({ page, scenario }) => {
  await openTwentyRows(page, scenario);
  await row(page, CODES[3]!).locator("[data-main]").click();
  await expect(row(page, CODES[3]!).locator("[data-main]")).toHaveAttribute("aria-current", "true");
  await settle(page);
  await resetProbe(page);
  await row(page, CODES[11]!).locator("[data-main]").click();
  await expect(row(page, CODES[11]!).locator("[data-main]")).toHaveAttribute("aria-current", "true");
  await expect(row(page, CODES[3]!).locator("[data-main]")).not.toHaveAttribute("aria-current", "true");
  await settle(page);
  const rendered = await frames(page);
  expect(new Set(rendered).size).toBeLessThanOrEqual(2);
  expect(rendered.length).toBeLessThanOrEqual(2);
});

const widthOf = async (target: Locator) => (await target.boundingBox())!.width;

test("도킹 경계를 끌어 창 폭을 바꿔도 열 수가 같으면 줄 틀을 다시 그리지 않는다", async ({ page, scenario }) => {
  await openTwentyRows(page, scenario);
  const divider = page.getByRole("separator", { name: "좌우 창 경계" });
  const before = await widthOf(panel(page));
  const box = (await divider.boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  const columns = () => row(page, CODES[0]!).locator("[data-cell]").count();
  const columnsBefore = await columns();
  await settle(page);
  await resetProbe(page);
  const widening = (await panel(page).boundingBox())!.x < x ? 100 : -100;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + widening / 2, y, { steps: 10 });
  await page.mouse.move(x + widening, y, { steps: 10 });
  await page.mouse.up();
  await expect.poll(() => widthOf(panel(page))).not.toBe(before);
  await settle(page);
  expect(await columns()).toBe(columnsBefore);
  expect(await frames(page)).toHaveLength(0);
});

test("줄을 끄는 동안 대상 줄이 바뀔 때 다시 그려지는 줄 틀은 세 개 이하다", async ({ page, scenario }) => {
  await openTwentyRows(page, scenario);
  const source = row(page, CODES[2]!);
  const first = row(page, CODES[8]!);
  const second = row(page, CODES[9]!);
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  await source.dispatchEvent("dragstart", { dataTransfer });
  await first.dispatchEvent("dragover", { dataTransfer });
  await expect(first).toHaveCSS("box-shadow", /inset/);
  await settle(page);
  await resetProbe(page);
  await second.dispatchEvent("dragover", { dataTransfer });
  await expect(second).toHaveCSS("box-shadow", /inset/);
  await settle(page);
  const rendered = await frames(page);
  expect(new Set(rendered).size).toBeLessThanOrEqual(3);
  expect(rendered.length).toBeLessThanOrEqual(3);
});
