import type { Page } from "@playwright/test";
import { cell, expect, SEARCH_BUTTON_TITLE, test, windowTab } from "./harness";

test.use({ viewport: { width: 1440, height: 900 } });

const PROBE_ATTR = "data-e2e-contextmenu-events";

interface ContextMenuRecord {
  defaultPrevented: boolean;
  shiftKey: boolean;
}

async function installContextMenuProbe(page: Page): Promise<void> {
  await page.evaluate((attr) => {
    const records: ContextMenuRecord[] = [];
    document.documentElement.setAttribute(attr, JSON.stringify(records));
    window.addEventListener("contextmenu", (event) => {
      records.push({ defaultPrevented: event.defaultPrevented, shiftKey: event.shiftKey });
      document.documentElement.setAttribute(attr, JSON.stringify(records));
    });
  }, PROBE_ATTR);
}

async function readContextMenuRecords(page: Page): Promise<ContextMenuRecord[]> {
  return page.evaluate((attr) => {
    const raw = document.documentElement.getAttribute(attr);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is ContextMenuRecord =>
        typeof item === "object"
        && item !== null
        && "defaultPrevented" in item
        && typeof item.defaultPrevented === "boolean"
        && "shiftKey" in item
        && typeof item.shiftKey === "boolean",
    );
  }, PROBE_ATTR);
}

test("일반 앱 크롬은 기본 컨텍스트 메뉴를 막고 Shift 우클릭은 허용한다", async ({ page }) => {
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await installContextMenuProbe(page);

  const topbarClock = page.getByRole("toolbar", { name: "차트 도구 막대" }).getByTestId("topbar-clock");
  const statusBar = page.getByRole("contentinfo");
  const pageRail = page.getByRole("navigation", { name: "페이지 메뉴" });

  await expect(topbarClock).toBeVisible();
  await expect(statusBar).toBeVisible();
  await expect(pageRail).toBeVisible();

  await topbarClock.click({ button: "right" });
  await statusBar.click({ button: "right" });
  await pageRail.click({ button: "right" });

  await topbarClock.click({ button: "right", modifiers: ["Shift"] });
  await statusBar.click({ button: "right", modifiers: ["Shift"] });
  await pageRail.click({ button: "right", modifiers: ["Shift"] });

  await expect.poll(() => readContextMenuRecords(page)).toEqual([
    { defaultPrevented: true, shiftKey: false },
    { defaultPrevented: true, shiftKey: false },
    { defaultPrevented: true, shiftKey: false },
    { defaultPrevented: false, shiftKey: true },
    { defaultPrevented: false, shiftKey: true },
    { defaultPrevented: false, shiftKey: true },
  ]);
});

test("편집 가능한 입력 요소는 기본 컨텍스트 메뉴를 허용하고 contenteditable=false는 막는다", async ({ page }) => {
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await installContextMenuProbe(page);

  await page.getByTitle(SEARCH_BUTTON_TITLE).click();
  const dialog = page.getByRole("dialog", { name: "종목 검색" });
  const searchInput = dialog.getByRole("combobox", { name: "종목 검색" });
  await expect(searchInput).toBeVisible();
  await searchInput.click({ button: "right" });
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  await page.evaluate(() => {
    const host = document.createElement("div");
    host.dataset.testid = "e2e-cm-editable-host";
    host.style.position = "fixed";
    host.style.top = "80px";
    host.style.left = "80px";
    host.style.zIndex = "9999";
    host.style.display = "flex";
    host.style.gap = "12px";
    host.style.padding = "12px";
    host.style.background = "#111";

    const textarea = document.createElement("textarea");
    textarea.dataset.testid = "e2e-cm-textarea";
    textarea.value = "메모";
    textarea.style.width = "120px";
    textarea.style.height = "40px";

    const editable = document.createElement("div");
    editable.dataset.testid = "e2e-cm-editable";
    editable.setAttribute("contenteditable", "true");
    editable.style.padding = "8px";

    const nestedSpan = document.createElement("span");
    nestedSpan.dataset.testid = "e2e-cm-editable-span";
    nestedSpan.textContent = "편집 가능";

    const nestedDisabled = document.createElement("span");
    nestedDisabled.dataset.testid = "e2e-cm-nested-disabled";
    nestedDisabled.setAttribute("contenteditable", "false");
    nestedDisabled.textContent = "편집 잠금";
    nestedDisabled.style.marginLeft = "8px";

    editable.append(nestedSpan, nestedDisabled);

    const disabled = document.createElement("div");
    disabled.dataset.testid = "e2e-cm-disabled";
    disabled.setAttribute("contenteditable", "false");
    disabled.textContent = "잠금 영역";
    disabled.style.padding = "8px";

    host.append(textarea, editable, disabled);
    document.body.append(host);
  });

  await page.getByTestId("e2e-cm-textarea").click({ button: "right" });
  await page.getByTestId("e2e-cm-editable-span").click({ button: "right" });
  await page.evaluate(() => {
    const span = document.querySelector('[data-testid="e2e-cm-editable-span"]');
    const textNode = span?.firstChild;
    if (!textNode) throw new Error("편집 가능한 텍스트 노드가 없습니다");
    textNode.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  });
  await page.getByTestId("e2e-cm-nested-disabled").click({ button: "right" });
  await page.getByTestId("e2e-cm-disabled").click({ button: "right" });

  await expect.poll(() => readContextMenuRecords(page)).toEqual([
    { defaultPrevented: false, shiftKey: false },
    { defaultPrevented: false, shiftKey: false },
    { defaultPrevented: false, shiftKey: false },
    { defaultPrevented: false, shiftKey: false },
    { defaultPrevented: true, shiftKey: false },
    { defaultPrevented: true, shiftKey: false },
  ]);
});

test("기존 커스텀 컨텍스트 메뉴는 전역 차단 아래에서도 정상적으로 열리고 동작한다", async ({ page, scenario }) => {
  scenario.documents.saveWatchlists({
    revision: 100,
    lists: [{ id: "source", name: "기본", symbols: ["005930", "086520"] }],
  });
  await page.goto("/?symbol=005930");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");

  const watchPanel = page.getByRole("complementary", { name: "관심종목" });
  const secondRow = watchPanel.locator('li[data-code="086520"] [data-main]');
  await expect(secondRow).toBeVisible();
  await secondRow.click({ button: "right" });
  const watchMenu = page.getByRole("menu", { name: /행 동작$/ });
  await expect(watchMenu).toBeVisible();
  await watchMenu.getByRole("menuitem", { name: /^맨 위로/ }).click();
  await expect(watchMenu).toBeHidden();
  await expect.poll(() => watchPanel.locator("li[data-code]").evaluateAll((rows) => rows.map((el) => el.getAttribute("data-code")))).toEqual(["086520", "005930"]);

  const dockGroups = page.locator("[data-dock-group]");
  const initialGroupCount = await dockGroups.count();
  await windowTab(page, "관심종목").click({ button: "right" });
  const dockMenu = page.getByRole("menu", { name: "창 배치" });
  await expect(dockMenu).toBeVisible();
  await dockMenu.getByRole("menuitem", { name: "아래에 나눠 놓기", exact: true }).click();
  await expect(dockMenu).toBeHidden();
  await expect(dockGroups).toHaveCount(initialGroupCount + 1);

  const chartBox = await cell(page).boundingBox();
  if (!chartBox) throw new Error("차트 영역이 없습니다");
  await page.mouse.click(chartBox.x + chartBox.width * 0.3, chartBox.y + chartBox.height * 0.3, { button: "right" });
  const drawingMenu = page.getByRole("menu", { name: "드로잉 메뉴", exact: true });
  await expect(drawingMenu).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(drawingMenu).toBeHidden();
});
