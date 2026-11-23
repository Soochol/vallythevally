import type { Locator } from "@playwright/test";
import { cell, expect, test } from "./harness";

test.use({ clockStart: "20261109100030", viewport: { width: 1440, height: 900 } });

const styleOf = (locator: Locator) => locator.evaluate((node) => {
  const style = getComputedStyle(node);
  return { background: style.backgroundColor, blur: style.backdropFilter, radius: style.borderTopLeftRadius };
});

test("명령 입력창은 차트를 어둡게 하거나 흐리게 하지 않고 유리 표면으로 뜨며 미리보기 지표가 범례에 보인다", async ({ page }, info) => {
  await page.goto("/?symbol=005930");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await page.getByRole("toolbar", { name: "차트 도구 막대" }).getByRole("button", { name: "지표", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "지표·비교 입력창", exact: true });
  await expect(dialog).toBeVisible();
  await page.keyboard.type("이평 20");
  await expect(cell(page).getByText("이동평균 단순 20", { exact: false }).first()).toBeVisible();
  expect(await styleOf(page.locator("[data-command-frame]"))).toMatchObject({ background: "rgba(0, 0, 0, 0)", blur: "none" });
  expect(await styleOf(dialog)).toMatchObject({ background: "rgba(27, 33, 27, 0.74)", blur: "blur(22px) saturate(1.6)", radius: "10px" });
  await page.screenshot({ path: info.outputPath("1440-indicator-preview.png") });
  await page.keyboard.press("Escape");

  await page.keyboard.press("/");
  const search = page.getByRole("dialog", { name: "종목 검색", exact: true });
  await expect(search).toBeVisible();
  expect(await styleOf(page.locator("[data-command-frame]"))).toMatchObject({ background: "rgba(5, 9, 5, 0.7)", blur: "none" });
  expect(await styleOf(search)).toMatchObject({ background: "rgb(27, 33, 27)", blur: "none" });
  await page.screenshot({ path: info.outputPath("1440-search.png") });
});

test("메뉴와 팝오버는 같은 유리 표면을 쓰고 재무자료 상태는 배경 없이 뜬다", async ({ page }, info) => {
  await page.goto("/?symbol=005930");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  const day = page.getByRole("toolbar", { name: "차트 도구 막대" }).getByRole("group", { name: "봉 주기" }).getByRole("button", { name: "일", exact: true });
  expect(await styleOf(day)).toMatchObject({ background: "rgb(35, 43, 35)" });
  const minuteButton = page.getByRole("button", { name: "분봉" }).first();
  await minuteButton.click();
  await expect(minuteButton).toHaveAttribute("aria-pressed", "true");
  await minuteButton.click();
  const minutes = page.locator(".minute-menu");
  await expect(minutes).toBeVisible();
  expect(await styleOf(minutes)).toMatchObject({ background: "rgba(27, 33, 27, 0.74)", blur: "blur(22px) saturate(1.6)", radius: "10px" });
  await page.screenshot({ path: info.outputPath("1440-minute-menu.png") });
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "재무자료", exact: true }).filter({ visible: true }).click();
  const financial = page.getByRole("dialog", { name: "재무자료", exact: true });
  await expect(financial).toBeVisible();
  await expect(page.locator(".ui-dialog-backdrop")).toHaveCount(0);
  expect(await styleOf(financial)).toMatchObject({ background: "rgba(27, 33, 27, 0.74)", blur: "blur(22px) saturate(1.6)" });
  await page.screenshot({ path: info.outputPath("1440-financial.png") });
});

test("틀·알림·툴팁·가림막 위 대화상자는 흐림 없이 불투명하고 메뉴만 유리를 유지한다", async ({ page }, info) => {
  await page.goto("/?symbol=005930");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  const toolbar = page.getByRole("toolbar", { name: "차트 도구 막대" });
  expect(await styleOf(toolbar)).toMatchObject({ background: "rgb(27, 33, 27)", blur: "none" });

  await toolbar.getByRole("button", { name: "지표", exact: true }).hover();
  const tip = page.getByRole("tooltip");
  await expect(tip).toBeVisible();
  expect(await styleOf(tip)).toMatchObject({ background: "rgb(45, 54, 45)", blur: "none" });
  await page.mouse.move(700, 450);

  await page.getByRole("button", { name: /^레이아웃:/ }).click();
  const layoutMenu = page.getByRole("menu", { name: "레이아웃", exact: true });
  expect(await styleOf(layoutMenu)).toMatchObject({ background: "rgba(27, 33, 27, 0.74)", blur: "blur(22px) saturate(1.6)" });
  await layoutMenu.getByRole("menuitem", { name: "새 이름으로 저장…", exact: true }).click();
  const naming = page.getByRole("dialog", { name: "새 이름으로 저장", exact: true });
  await expect(naming).toBeVisible();
  expect(await styleOf(naming)).toMatchObject({ background: "rgb(27, 33, 27)", blur: "none" });
  await page.screenshot({ path: info.outputPath("1440-naming-dialog.png") });
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "스크리너 닫기", exact: true }).click();
  const toast = page.locator(".ui-toast").filter({ hasText: "스크리너 창을 닫았습니다" });
  await expect(toast).toBeVisible();
  expect(await styleOf(toast)).toMatchObject({ background: "rgb(45, 54, 45)", blur: "none" });
  await page.screenshot({ path: info.outputPath("1440-toast.png") });
});

test("투명도 줄이기를 켜면 유리 표면은 흐림 없이 불투명하게 그려진다", async ({ context, page }) => {
  await page.goto("/?symbol=005930");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  const cdp = await context.newCDPSession(page);
  await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-transparency", value: "reduce" }] });
  const minuteButton = page.getByRole("button", { name: "분봉" }).first();
  await minuteButton.click();
  await expect(minuteButton).toHaveAttribute("aria-pressed", "true");
  await minuteButton.click();
  const minutes = page.locator(".minute-menu");
  await expect(minutes).toBeVisible();
  expect(await styleOf(minutes)).toMatchObject({ background: "rgb(27, 33, 27)", blur: "none" });
  expect(await styleOf(page.getByRole("toolbar", { name: "차트 도구 막대" }))).toMatchObject({ background: "rgb(27, 33, 27)", blur: "none" });
});

test("드로잉 삭제 알림의 되돌리기는 Ctrl+Z 표시를 화면에만 보이고 접근성 이름은 되돌리기 그대로다", async ({ page }) => {
  await page.goto("/?symbol=005930");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  const box = (await cell(page).boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.4, box.y + box.height * 0.6, { button: "right" });
  await page.getByRole("menu", { name: "드로잉 메뉴", exact: true }).getByRole("menuitem", { name: /이 가격에 수평선/ }).click();
  await page.mouse.click(box.x + box.width * 0.4, box.y + box.height * 0.25, { button: "right" });
  await page.getByRole("menu", { name: "드로잉 메뉴", exact: true }).getByRole("menuitem", { name: /일 이상 드로잉 모두 지우기/ }).click();
  const undo = page.getByRole("status").getByRole("button", { name: "되돌리기", exact: true });
  await expect(undo).toBeVisible();
  await expect(undo.locator("kbd")).toHaveText("Ctrl+Z");
  await expect(undo).toHaveAttribute("aria-keyshortcuts", "Control+Z Meta+Z");
});
