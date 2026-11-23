import type { Locator, Page } from "@playwright/test";
import { type Scenario, cell, expect, test, windowTabs } from "./harness";

test.use({ viewport: { width: 1440, height: 900 } });

const CODES = Array.from({ length: 80 }, (_, i) => String(950_000 + i * 10));
const dialog = (page: Page) => page.getByRole("dialog", { name: "시스템 설정", exact: true });
const panel = (page: Page) => page.getByRole("complementary", { name: "관심종목" });
const rows = (page: Page) => panel(page).locator("li[data-code]");
const root = (page: Page) => page.locator("html");
const frames = (page: Page): Locator[] => [page.getByRole("toolbar", { name: "차트 도구 막대" }), windowTabs(page).first(), page.locator("footer.status-bar")];

function seed(scenario: Scenario) {
  scenario.documents.saveWatchlists({ revision: 100, lists: [{ id: "all", name: "기본", symbols: CODES }] });
}

async function open(page: Page) {
  await page.goto("/?symbol=005930");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await expect(rows(page).first()).toBeVisible();
}

async function openSettings(page: Page) {
  await page.getByRole("button", { name: "시스템 설정", exact: true }).click();
  await dialog(page).getByRole("tab", { name: /^일반/ }).click();
}

const density = (page: Page, name: "기본" | "촘촘") => dialog(page).getByRole("radio", { name, exact: true });

const rowHeight = (page: Page) => rows(page).first().evaluate((el) => el.getBoundingClientRect().height);

const visibleRows = (page: Page) =>
  panel(page).getByRole("list").evaluate((list) => {
    const frame = (list.closest(".overflow-y-auto") ?? list).getBoundingClientRect();
    return [...list.querySelectorAll("li[data-code]")].filter((li) => {
      const box = li.getBoundingClientRect();
      return box.top >= frame.top - 1 && box.bottom <= frame.bottom + 1;
    }).length;
  });

const heights = (page: Page) => Promise.all(frames(page).map((frame) => frame.evaluate((el) => el.getBoundingClientRect().height)));

test("저장된 값이 없는 처음에는 촘촘 28px 줄이고 설정에서 촘촘이 골라져 있다", async ({ scenario, page }) => {
  seed(scenario);
  await open(page);
  await expect(root(page)).toHaveAttribute("data-density", "compact");
  await expect.poll(() => rowHeight(page)).toBe(28);
  await openSettings(page);
  await expect(density(page, "촘촘")).toBeChecked();
  await expect(density(page, "기본")).not.toBeChecked();
});

test("기본과 촘촘을 고르면 대화상자를 닫지 않아도 줄 높이와 보이는 줄 수가 바뀐다", async ({ scenario, page }) => {
  seed(scenario);
  await open(page);
  const compactRows = await visibleRows(page);
  await openSettings(page);
  await density(page, "기본").click();
  await expect(dialog(page)).toBeVisible();
  await expect(root(page)).toHaveAttribute("data-density", "regular");
  await expect.poll(() => rowHeight(page)).toBe(34);
  const regularRows = await visibleRows(page);
  expect(regularRows).toBeLessThan(compactRows);
  await density(page, "촘촘").click();
  await expect(dialog(page)).toBeVisible();
  await expect.poll(() => rowHeight(page)).toBe(28);
  expect(await visibleRows(page)).toBeGreaterThan(regularRows);
});

test("기본을 고른 뒤 새로 고침해도 34px이다", async ({ scenario, page }) => {
  seed(scenario);
  await open(page);
  await openSettings(page);
  await density(page, "기본").click();
  await expect.poll(() => rowHeight(page)).toBe(34);
  await page.reload();
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await expect(root(page)).toHaveAttribute("data-density", "regular");
  await expect.poll(() => rowHeight(page)).toBe(34);
  await openSettings(page);
  await expect(density(page, "기본")).toBeChecked();
});

test("촘촘에서도 위 막대와 탭 줄과 상태 줄의 높이는 그대로다", async ({ scenario, page }) => {
  seed(scenario);
  await open(page);
  await expect.poll(() => rowHeight(page)).toBe(28);
  const compact = await heights(page);
  await openSettings(page);
  await density(page, "기본").click();
  await expect.poll(() => rowHeight(page)).toBe(34);
  await page.keyboard.press("Escape");
  await expect(dialog(page)).toHaveCount(0);
  expect(await heights(page)).toEqual(compact);
});

test("촘촘에서 보이는 모든 글자가 11px 이상이다", async ({ scenario, page }) => {
  seed(scenario);
  await open(page);
  await expect.poll(() => rowHeight(page)).toBe(28);
  const small = await page.evaluate(() => {
    const found: string[] = [];
    for (const el of document.body.querySelectorAll<HTMLElement>("*")) {
      const own = [...el.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && n.textContent!.trim() !== "");
      const box = el.getBoundingClientRect();
      if (!own || box.width === 0 || box.height === 0) continue;
      const size = parseFloat(getComputedStyle(el).fontSize);
      if (size < 11) found.push(`${el.tagName.toLowerCase()} ${size}px ${el.textContent!.trim().slice(0, 20)}`);
    }
    return found;
  });
  expect(small).toEqual([]);
});

test("다른 브라우저 문맥은 기본을 고른 문맥이 있어도 촘촘으로 시작한다", async ({ scenario, page, browser }) => {
  seed(scenario);
  await open(page);
  await openSettings(page);
  await density(page, "기본").click();
  await expect.poll(() => rowHeight(page)).toBe(34);
  const fresh = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  try {
    await scenario.install(fresh);
    const other = await fresh.newPage();
    await open(other);
    await expect(root(other)).toHaveAttribute("data-density", "compact");
    await expect.poll(() => rowHeight(other)).toBe(28);
  } finally {
    await fresh.close();
  }
});

test("저장소를 쓸 수 없어도 촘촘 28px로 그리고 오류 화면이 뜨지 않는다", async ({ scenario, page }) => {
  seed(scenario);
  await page.addInitScript(() => {
    Object.defineProperty(window, "localStorage", { get() { throw new DOMException("denied", "SecurityError"); } });
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await open(page);
  await expect(root(page)).toHaveAttribute("data-density", "compact");
  await expect.poll(() => rowHeight(page)).toBe(28);
  await expect(cell(page)).toBeVisible();
  await openSettings(page);
  await density(page, "기본").click();
  await expect.poll(() => rowHeight(page)).toBe(34);
  expect(errors).toEqual([]);
});
