import type { Page } from "@playwright/test";
import { type Scenario, cell, expect, test } from "./harness";

test.use({ viewport: { width: 1440, height: 900 } });

const CODES = Array.from({ length: 20 }, (_, i) => String(950_000 + i * 10));
const dialog = (page: Page) => page.getByRole("dialog", { name: "시스템 설정", exact: true });
const rows = (page: Page) => page.getByRole("complementary", { name: "관심종목" }).locator("li[data-code]");
const root = (page: Page) => page.locator("html");
const density = (page: Page, name: "기본" | "촘촘") => dialog(page).getByRole("radio", { name, exact: true });

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

const shownDensity = async (page: Page) => ((await density(page, "기본").getAttribute("aria-checked")) === "true" ? "regular" : "compact");

test.describe("밀도 표시는 실제 줄 높이를 따른다", () => {
  test("밀도를 저장하지 못하는 브라우저에서 기본을 고르고 설정을 다시 열면 기본이 골라져 있다", async ({ scenario, page }) => {
    seed(scenario);
    await page.addInitScript(() => {
      const get = Storage.prototype.getItem;
      const set = Storage.prototype.setItem;
      Storage.prototype.getItem = function (this: Storage, key: string) {
        if (key === "vally.density") throw new DOMException("blocked", "SecurityError");
        return get.call(this, key);
      };
      Storage.prototype.setItem = function (this: Storage, key: string, value: string) {
        if (key === "vally.density") throw new DOMException("blocked", "SecurityError");
        return set.call(this, key, value);
      };
    });
    await open(page);
    await openSettings(page);
    await density(page, "기본").click();
    await expect(root(page)).toHaveAttribute("data-density", "regular");
    await page.keyboard.press("Escape");
    await expect(dialog(page)).toHaveCount(0);
    await openSettings(page);
    await expect(density(page, "기본")).toBeChecked();
    await expect(root(page)).toHaveAttribute("data-density", "regular");
  });

  test("다른 탭에서 밀도를 바꾼 뒤 이 탭 설정을 열면 골라진 값이 이 탭의 실제 밀도와 같다", async ({ scenario, page }) => {
    seed(scenario);
    await open(page);
    await expect(root(page)).toHaveAttribute("data-density", "compact");
    const other = await page.context().newPage();
    await open(other);
    await openSettings(other);
    await density(other, "기본").click();
    await expect(root(other)).toHaveAttribute("data-density", "regular");
    await page.bringToFront();
    await openSettings(page);
    await expect.poll(async () => (await shownDensity(page)) === (await root(page).getAttribute("data-density"))).toBe(true);
  });
});
