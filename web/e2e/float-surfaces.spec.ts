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
  expect(await styleOf(dialog)).toMatchObject({ background: "rgba(27, 33, 27, 0.74)", blur: "blur(22px) saturate(1.6)", radius: "16px" });
  await page.screenshot({ path: info.outputPath("1440-indicator-preview.png") });
  await page.keyboard.press("Escape");

  await page.keyboard.press("/");
  const search = page.getByRole("dialog", { name: "종목 검색", exact: true });
  await expect(search).toBeVisible();
  expect(await styleOf(page.locator("[data-command-frame]"))).toMatchObject({ background: "rgba(0, 0, 0, 0)", blur: "none" });
  await page.screenshot({ path: info.outputPath("1440-search.png") });
});

test("메뉴와 팝오버는 같은 유리 표면을 쓰고 일반 대화상자만 배경을 어둡게 한다", async ({ page }, info) => {
  await page.goto("/?symbol=005930");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await page.getByRole("button", { name: "분봉" }).first().click();
  const minutes = page.locator(".minute-menu");
  await expect(minutes).toBeVisible();
  expect(await styleOf(minutes)).toMatchObject({ background: "rgba(27, 33, 27, 0.74)", blur: "blur(22px) saturate(1.6)", radius: "16px" });
  await page.screenshot({ path: info.outputPath("1440-minute-menu.png") });
  await page.keyboard.press("Escape");

  const day = page.getByRole("toolbar", { name: "차트 도구 막대" }).getByRole("group", { name: "봉 주기" }).getByRole("button", { name: "일", exact: true });
  expect(await styleOf(day)).toMatchObject({ background: "rgb(199, 243, 107)" });

  await page.getByRole("button", { name: "재무자료", exact: true }).filter({ visible: true }).click();
  const financial = page.getByRole("dialog", { name: "재무자료", exact: true });
  await expect(financial).toBeVisible();
  expect(await styleOf(page.locator(".ui-dialog-backdrop"))).toMatchObject({ background: "rgba(5, 9, 5, 0.7)", blur: "none" });
  expect(await styleOf(financial)).toMatchObject({ background: "rgba(27, 33, 27, 0.74)", blur: "blur(22px) saturate(1.6)" });
  await page.screenshot({ path: info.outputPath("1440-dialog.png") });
});
