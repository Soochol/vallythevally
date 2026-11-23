import type { Page } from "@playwright/test";
import { cell, expect, test } from "./harness";

const topbar = (page: Page) => page.getByRole("toolbar", { name: "차트 도구 막대" });
const layoutTrigger = (page: Page) => topbar(page).getByRole("button", { name: /^레이아웃:/ });
const layoutMenu = (page: Page) => page.getByRole("menu", { name: "레이아웃", exact: true });
const arrangeMenu = (page: Page) => page.getByRole("menu", { name: "배치", exact: true });

async function open(page: Page, width: number) {
  await page.setViewportSize({ width, height: 900 });
  await page.goto("/?symbol=005930");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
}

test("1440px에서 봉 주기 조각·버튼·거래소·검색창 높이가 모두 30px이다", async ({ page }) => {
  await open(page, 1440);
  const bar = topbar(page);
  const heights = await bar.evaluate((el) => {
    const height = (node: Element | null) => Math.round((node?.getBoundingClientRect().height ?? 0) * 10) / 10;
    return {
      group: height(el.querySelector("[aria-label='봉 주기']")),
      pieces: [...el.querySelectorAll("[aria-label='봉 주기'] button")].map(height),
      buttons: [...el.querySelectorAll(".tb-btn")].map(height).filter((value) => value > 0),
      venue: height(el.querySelector(".venue-picker")),
      search: height(el.querySelector(".shell-search")),
    };
  });
  expect(heights.group).toBe(30);
  expect(heights.pieces.length).toBeGreaterThan(3);
  for (const piece of heights.pieces) expect(piece).toBe(30);
  expect(heights.buttons.length).toBeGreaterThan(4);
  for (const button of heights.buttons) expect(button).toBe(30);
  expect(heights.venue).toBe(30);
  expect(heights.search).toBe(30);
});

for (const width of [1280, 1024, 832, 800]) {
  test(`${width}px에서 위 막대가 넘치지 않고 모든 조작에 닿을 수 있다`, async ({ page }) => {
    await open(page, width);
    const bar = topbar(page);
    const { scroll, client } = await bar.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }));
    expect(scroll).toBeLessThanOrEqual(client);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
    const folded = width < 832;
    for (const name of ["지표", "레이아웃: 기본", "배치", "창 더하기", "시스템 설정"]) {
      await expect(bar.getByRole("button", { name: name === "레이아웃: 기본" ? /^레이아웃:/ : name, exact: name !== "레이아웃: 기본" })).toBeVisible();
    }
    await expect(bar.getByRole("button", { name: "더 보기", exact: true })).toHaveCount(folded ? 1 : 0);
    await expect(bar.getByRole("button", { name: "비교", exact: true })).toHaveCount(folded ? 0 : 1);
    await expect(bar.getByRole("button", { name: "차트 설정", exact: true })).toHaveCount(folded ? 0 : 1);
    await expect(bar.getByRole("button", { name: "종목·지표·명령 찾기" })).toBeVisible();
    if (folded) {
      await bar.getByRole("button", { name: "더 보기", exact: true }).click();
      const more = page.getByRole("menu", { name: "더 보기", exact: true });
      await expect(more.getByRole("menuitem", { name: "비교", exact: true })).toBeVisible();
      await more.getByRole("menuitem", { name: "차트 설정", exact: true }).click();
      await expect(page.getByRole("dialog").first()).toBeVisible();
    }
  });
}

test("레이아웃 메뉴에는 창 배치 방식이 없고 배치 메뉴에 있으며 되돌리기에 Ctrl+Z가 보인다", async ({ page }) => {
  await open(page, 1440);
  await layoutTrigger(page).click();
  await expect(layoutMenu(page).getByText("창 배치 방식")).toHaveCount(0);
  for (const name of ["기본 배치로", "크기 모두 고르게", "배치 되돌리기", "배치 다시 하기"]) await expect(layoutMenu(page).getByRole("menuitem", { name })).toHaveCount(0);
  await expect(layoutMenu(page).getByRole("menuitem", { name: "새 이름으로 저장…" })).toBeVisible();
  await page.keyboard.press("Escape");

  await topbar(page).getByRole("button", { name: "배치", exact: true }).click();
  const menu = arrangeMenu(page);
  await expect(menu.getByRole("group", { name: "창 배치 방식" })).toBeVisible();
  const undo = menu.getByRole("menuitem", { name: /^배치 되돌리기/ });
  await expect(undo).toContainText("Ctrl+Z");
  await expect(undo).toBeDisabled();
  await expect(menu.getByText("되돌릴 배치 변경이 없습니다")).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: /^배치 다시 하기/ })).toContainText("Ctrl+Shift+Z");
});

test("레이아웃 지우기 확인창에 함께 지워지는 것이 적혀 있다", async ({ page }) => {
  await open(page, 1440);
  await layoutTrigger(page).click();
  await layoutMenu(page).getByRole("menuitem", { name: "새 이름으로 저장…", exact: true }).click();
  const naming = page.getByRole("dialog", { name: "새 이름으로 저장", exact: true });
  const input = naming.getByRole("textbox", { name: "레이아웃 이름" });
  await expect(input).toHaveValue(/ 사본$/);
  expect(await input.evaluate((el: HTMLInputElement) => el.selectionStart === 0 && el.selectionEnd === el.value.length)).toBe(true);
  await expect(naming.getByText("1~20자")).toBeVisible();
  await input.fill("복기");
  await naming.getByRole("button", { name: "저장", exact: true }).click();
  await expect(layoutTrigger(page)).toHaveAccessibleName("레이아웃: 복기");
  await layoutTrigger(page).click();
  await layoutMenu(page).getByRole("menuitem", { name: "지우기", exact: true }).click();
  const confirm = page.getByRole("dialog", { name: "복기 레이아웃을 지웁니다" });
  await expect(confirm).toContainText("창 배치와 이 레이아웃에만 그린 드로잉이 함께 지워집니다. 되돌릴 수 없습니다");
});

test("검색창 자리표시 글자의 대비가 4.5:1 이상이다", async ({ page }) => {
  await open(page, 1440);
  const ratio = await topbar(page).evaluate((bar) => {
    const probe = document.createElement("canvas").getContext("2d")!;
    const rgb = (css: string) => { probe.fillStyle = "#000"; probe.fillStyle = css; probe.fillRect(0, 0, 1, 1); return [...probe.getImageData(0, 0, 1, 1).data].slice(0, 3); };
    const luminance = ([r, g, b]: number[]) => { const [lr, lg, lb] = [r, g, b].map((v) => { const c = v! / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }); return 0.2126 * lr! + 0.7152 * lg! + 0.0722 * lb!; };
    const hint = bar.querySelector(".shell-search-hint")!;
    const text = luminance(rgb(getComputedStyle(hint).color));
    const back = luminance(rgb(getComputedStyle(bar.querySelector(".shell-search")!).backgroundColor));
    return (Math.max(text, back) + 0.05) / (Math.min(text, back) + 0.05);
  });
  expect(ratio).toBeGreaterThanOrEqual(4.5);
});
