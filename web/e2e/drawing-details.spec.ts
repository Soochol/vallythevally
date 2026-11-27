import type { Locator, Page } from "@playwright/test";
import { cell, expect, pollSaved, test } from "./harness";
import { chartPoint, drawingDock, drawings, mirror, open } from "./drawing-probe";

test.use({ viewport: { width: 1440, height: 900 } });

interface PaintedLabel { color: string; background: [number, number, number, number] }
declare global { interface Window { paintedPriceLabels: PaintedLabel[] } }

function installLabelProbe() {
  window.paintedPriceLabels = [];
  const fillText = CanvasRenderingContext2D.prototype.fillText;
  CanvasRenderingContext2D.prototype.fillText = function (value, x, y, maxWidth) {
    const box = this.canvas.getBoundingClientRect();
    if (box.width > 0 && box.width <= 120 && /^[\d,.]+$/.test(value)) {
      const transform = this.getTransform();
      const ratio = this.canvas.width / box.width;
      const pixel = this.getImageData(Math.max(0, Math.round(x * transform.a + transform.e - 2 * ratio)), Math.round(y * transform.d + transform.f), 1, 1).data;
      window.paintedPriceLabels.push({ color: String(this.fillStyle), background: [pixel[0]!, pixel[1]!, pixel[2]!, pixel[3]!] });
    }
    return fillText.call(this, value, x, y, maxWidth);
  };
}

const channels = (css: string): [number, number, number] => {
  const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(css.trim());
  if (hex) return [parseInt(hex[1]!, 16), parseInt(hex[2]!, 16), parseInt(hex[3]!, 16)];
  const rgb = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(css.trim());
  if (!rgb) throw new Error(`색을 읽을 수 없습니다: ${css}`);
  return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
};
const luminance = ([r, g, b]: readonly number[]) => {
  const [lr, lg, lb] = [r!, g!, b!].map((value) => { const c = value / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * lr! + 0.7152 * lg! + 0.0722 * lb!;
};
const contrast = (a: readonly number[], b: readonly number[]) => {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (high! + 0.05) / (low! + 0.05);
};

const drawColor = (page: Page) => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--draw").trim());

async function placeWith(page: Page, key: string, spots: readonly (readonly [number, number])[], drag = false) {
  await cell(page).focus();
  await page.keyboard.press(key);
  const [first, second] = await Promise.all(spots.map(([fx, fy]) => chartPoint(page, fx, fy)));
  await page.mouse.move(first!.x, first!.y, { steps: 4 });
  if (drag) {
    await page.mouse.down();
    await page.mouse.move(second!.x, second!.y, { steps: 10 });
    await page.mouse.up();
    return;
  }
  await page.mouse.click(first!.x, first!.y);
  await page.mouse.move(second!.x, second!.y, { steps: 4 });
  await page.mouse.click(second!.x, second!.y);
}

const detailsDialog = (page: Page, title: string) => page.getByRole("dialog", { name: `${title} 세부 설정`, exact: true });

async function placeFibAndOpenDetails(page: Page) {
  await open(page);
  await placeWith(page, "F", [[0.1, 0.3], [0.22, 0.6]]);
  await expect.poll(async () => (await mirror(page)).some((d) => d.tool === "fib" && d.selected)).toBe(true);
  await page.getByRole("button", { name: "드로잉 세부 설정", exact: true }).click();
  const dialog = detailsDialog(page, "피보나치 되돌림");
  await expect(dialog).toBeVisible();
  return dialog;
}

async function box(locator: Locator) {
  const found = await locator.boundingBox();
  if (!found) throw new Error("화면에 없는 요소입니다");
  return found;
}

test("피보나치 세부 설정 창은 화면 중앙에 560px 안으로 뜨고 헤더 드래그 이동·중앙 복귀·템플릿·주기 프리셋이 동작한다", async ({ page }, testInfo) => {
  const dialog = await placeFibAndOpenDetails(page);
  if (process.env.VALLY_E2E_SCREENSHOTS === "1") await page.screenshot({ path: testInfo.outputPath("details-fib.png") });
  const frame = await box(dialog);
  expect(frame.width).toBeLessThanOrEqual(472);
  expect(frame.height).toBeLessThanOrEqual(560);
  const topbar = await box(page.getByRole("toolbar", { name: "차트 도구 막대", exact: true }));
  expect(frame.y).toBeGreaterThanOrEqual(topbar.y + topbar.height);
  expect(Math.abs((frame.x + frame.width / 2) - 720)).toBeLessThanOrEqual(24);
  await expect(dialog.getByRole("tablist", { name: "세부 설정 묶음", exact: true }).getByRole("tab")).toHaveText(["스타일", "좌표", "보이기"]);

  const head = await box(dialog.locator(".draw-dialog-head"));
  const dragStart = { x: head.x + head.width / 2, y: head.y + head.height / 2 };
  await page.mouse.move(dragStart.x, dragStart.y);
  await page.mouse.down();
  await page.mouse.move(dragStart.x + 180, dragStart.y + 40, { steps: 6 });
  await page.mouse.up();
  const moved = await box(dialog);
  expect(moved.x).toBeGreaterThan(frame.x + 120);
  expect(moved.y).toBeGreaterThanOrEqual(topbar.y + topbar.height);

  await dialog.getByRole("button", { name: "중앙으로 이동", exact: true }).click();
  const recentered = await box(dialog);
  expect(Math.abs((recentered.x + recentered.width / 2) - 720)).toBeLessThanOrEqual(24);

  await dialog.getByRole("button", { name: /템플릿/ }).click();
  const tplPop = page.getByRole("dialog", { name: "스타일 템플릿", exact: true });
  await expect(tplPop).toBeVisible();
  await expect(tplPop.getByRole("button", { name: "기본 스타일로", exact: true })).toBeVisible();
  await expect(tplPop.getByRole("button", { name: "현재 스타일을 기본값으로 저장", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(tplPop).toBeHidden();
  await expect(dialog).toBeVisible();

  await dialog.getByRole("tab", { name: "보이기", exact: true }).click();
  await dialog.getByRole("button", { name: "분봉만", exact: true }).click();
  await expect(dialog.getByRole("checkbox", { name: "모든 봉 주기", exact: true })).not.toBeChecked();
  await expect(dialog.getByRole("checkbox", { name: "1분", exact: true })).toBeChecked();
  await expect(dialog.getByRole("checkbox", { name: "일", exact: true })).not.toBeChecked();
});

test("피보나치 수준 줄은 40px 안에 다섯 칸이 한 줄로 놓인다", async ({ page }) => {
  const dialog = await placeFibAndOpenDetails(page);
  const rows = dialog.getByRole("group", { name: /^수준 \d+$/ });
  expect(await rows.count()).toBeGreaterThanOrEqual(5);
  for (const index of [0, 3]) {
    const row = rows.nth(index);
    const name = `수준 ${index + 1}`;
    const rowBox = await box(row);
    expect(rowBox.height).toBeLessThanOrEqual(40);
    const cells = [
      row.getByRole("switch", { name: `${name} 켜기`, exact: true }),
      row.getByRole("spinbutton", { name: `${name} 값`, exact: true }),
      row.getByRole("button", { name: `${name} 색 선택`, exact: true }),
      row.getByRole("img", { name: `${name} 선 견본`, exact: true }),
      row.getByRole("button", { name: `${name} 지우기`, exact: true }),
    ];
    const boxes = await Promise.all(cells.map(box));
    const centers = boxes.map((b) => b.y + b.height / 2);
    expect(Math.max(...centers) - Math.min(...centers)).toBeLessThanOrEqual(2);
    boxes.forEach((b, i) => {
      expect(b.y).toBeGreaterThanOrEqual(rowBox.y - 1);
      expect(b.y + b.height).toBeLessThanOrEqual(rowBox.y + rowBox.height + 1);
      if (i > 0) expect(b.x).toBeGreaterThanOrEqual(boxes[i - 1]!.x + boxes[i - 1]!.width - 1);
    });
    expect(boxes[1]!.width).toBeCloseTo(60, 0);
    expect(boxes[2]!.width).toBeCloseTo(24, 0);
    expect(boxes[4]!.width).toBeCloseTo(24, 0);
  }
  await expect(dialog.getByText(/^#[0-9A-F]{6}$/i).filter({ visible: true })).toHaveCount(0);
  const second = rows.nth(1);
  const swatch = await second.getByRole("button", { name: "수준 2 색 선택", exact: true }).locator("i").evaluate((el) => getComputedStyle(el).backgroundColor);
  const sample = await second.getByRole("img", { name: "수준 2 선 견본", exact: true }).locator("i").evaluate((el) => getComputedStyle(el).borderTopColor);
  expect(sample).toBe(swatch);
});

test("고른 추세선의 가격 꼬리표는 글자와 바탕의 대비가 4.5:1 이상이다", async ({ page }) => {
  await page.addInitScript(installLabelProbe);
  await open(page);
  await placeWith(page, "T", [[0.3, 0.7], [0.6, 0.3]], true);
  await expect.poll(async () => (await mirror(page)).some((d) => d.tool === "trendline" && d.selected)).toBe(true);
  await page.mouse.move(5, 5);
  const back = channels(await drawColor(page));
  await expect.poll(() => page.evaluate((target) => window.paintedPriceLabels.filter((l) => l.background[3] === 255 && l.background.slice(0, 3).every((v, i) => Math.abs(v - target[i]!) <= 2)).length, back)).toBeGreaterThanOrEqual(2);
  const labels = await page.evaluate((target) => window.paintedPriceLabels.filter((l) => l.background[3] === 255 && l.background.slice(0, 3).every((v, i) => Math.abs(v - target[i]!) <= 2)), back);
  for (const label of labels) expect(contrast(channels(label.color), label.background)).toBeGreaterThanOrEqual(4.5);
});

test("새로 그린 추세선의 색은 강조색이 아니다", async ({ page, scenario }) => {
  await open(page);
  await placeWith(page, "T", [[0.3, 0.7], [0.6, 0.3]], true);
  await pollSaved(async () => (await drawings(scenario)).length).toBe(1);
  const saved = (await drawings(scenario))[0]!.style as { line: { color: string } };
  const resolved = await page.evaluate((color) => {
    const rgb = (css: string) => {
      const probe = document.createElement("i");
      probe.style.color = css;
      document.body.append(probe);
      const value = getComputedStyle(probe).color;
      probe.remove();
      return value;
    };
    const token = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(`--${name}`).trim();
    return { drawn: rgb(color.startsWith("$") ? token(color.slice(1)) : color), accent: rgb(token("accent")) };
  }, saved.line.color);
  expect(resolved.drawn).not.toBe("rgb(199, 243, 107)");
  expect(resolved.drawn).not.toBe(resolved.accent);
});

test("그룹 버튼을 누르면 마지막 도구가 골라지고 우클릭이나 길게 누르면 그룹 메뉴가 열린다", async ({ page }) => {
  await open(page);
  const dock = drawingDock(page);
  const menu = page.getByRole("menu", { name: "선 도구", exact: true });
  const first = dock.getByRole("button", { name: "추세선", exact: true });
  await first.click({ button: "right" });
  await expect(menu).toBeVisible();
  await menu.getByRole("menuitem", { name: /^수평선/ }).click();
  await expect(dock.getByRole("button", { name: "수평선", exact: true })).toHaveAttribute("aria-pressed", "true");
  await dock.getByRole("button", { name: "선택 도구", exact: true }).click();
  const last = dock.getByRole("button", { name: "수평선", exact: true });
  await expect(last).toHaveAttribute("aria-pressed", "false");
  await last.click();
  await expect(last).toHaveAttribute("aria-pressed", "true");
  await expect(menu).toHaveCount(0);

  await last.click({ button: "right" });
  await expect(menu).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);

  const spot = await box(last);
  await dock.getByRole("button", { name: "선택 도구", exact: true }).click();
  await page.mouse.move(spot.x + spot.width / 2, spot.y + spot.height / 2);
  await page.mouse.down();
  await expect(menu).toBeVisible();
  await page.mouse.up();
  await expect(last).toHaveAttribute("aria-pressed", "false");
  await page.keyboard.press("Escape");

  await last.focus();
  await page.keyboard.press("ArrowRight");
  await expect(menu).toBeVisible();
});

test("단축키 도움말은 480px 폭 안에서 도구 표와 묶음 넷으로 나뉜다", async ({ page }, testInfo) => {
  await open(page);
  await drawingDock(page).getByRole("button", { name: "드로잉 단축키 도움말", exact: true }).click();
  const help = page.getByRole("dialog", { name: "드로잉 단축키", exact: true });
  await expect(help).toBeVisible();
  if (process.env.VALLY_E2E_SCREENSHOTS === "1") await page.screenshot({ path: testInfo.outputPath("help.png") });
  const frame = await box(help);
  expect(frame.width).toBeLessThanOrEqual(480);
  expect(frame.height).toBeLessThanOrEqual(900 * 0.7 + 1);
  await expect(help.getByRole("region", { name: "도구 단축키", exact: true })).toBeVisible();
  for (const title of ["그리기", "고르기", "옮기기·복제", "지우기"]) await expect(help.getByRole("region", { name: title, exact: true })).toBeVisible();
  const [drawing, selecting] = await Promise.all([box(help.getByRole("region", { name: "그리기", exact: true })), box(help.getByRole("region", { name: "고르기", exact: true }))]);
  expect(selecting.x).toBeGreaterThan(drawing.x + drawing.width - 1);
});
