import { readFile } from "node:fs/promises";
import type { Download, Locator, Page } from "@playwright/test";
import { type Scenario, cell, chartOf, expect, test } from "./harness";

const HEAD_LINE = 22;
const HEAD_PAD = 12;
const FOOT_HEIGHT = 18;
const PAD_X = 12;
const CREDIT = "Charts by TradingView Lightweight Charts™";
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const LONG_NAME = "TIGER 미국나스닥100타겟데일리커버드콜";

interface DrawnText {
  text: string;
  x: number;
  y: number;
  w: number;
}

function pngSize(bytes: Buffer): { width: number; height: number } {
  expect([...bytes.subarray(0, 8)]).toEqual(PNG_SIGNATURE);
  expect(bytes.subarray(12, 16).toString("ascii")).toBe("IHDR");
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

async function recordComposedText(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const drawn: DrawnText[] = [];
    Object.assign(window, { composedText: drawn });
    const fillText = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function (text, x, y, maxWidth) {
      if (!this.canvas.isConnected) drawn.push({ text, x, y, w: this.measureText(text).width });
      return fillText.call(this, text, x, y, maxWidth);
    };
  });
}

async function takeComposedText(page: Page): Promise<DrawnText[]> {
  return page.evaluate(() => {
    const drawn = (window as unknown as { composedText: DrawnText[] }).composedText;
    return drawn.splice(0, drawn.length);
  });
}

function expectNoOverlap(drawn: DrawnText[], width: number): void {
  for (const t of drawn) {
    expect(t.x, `${t.text}의 왼쪽 끝`).toBeGreaterThanOrEqual(0);
    expect(t.x + t.w, `${t.text}의 오른쪽 끝`).toBeLessThanOrEqual(width);
  }
  for (const [i, a] of drawn.entries()) {
    for (const b of drawn.slice(i + 1)) {
      if (a.y !== b.y) continue;
      const overlap = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
      expect(overlap, `${a.text}와 ${b.text}가 겹친다`).toBeLessThanOrEqual(0);
    }
  }
}

interface Ink {
  head: number;
  up: number;
  down: number;
}

async function measureInk(page: Page, b64: string, headPx: number, chartPx: number): Promise<Ink> {
  return page.evaluate(
    async ({ b64, headPx, chartPx }) => {
      const rgb = (token: string) => {
        const probe = document.createElement("span");
        probe.style.color = `var(${token})`;
        document.body.append(probe);
        const [r, g, b] = getComputedStyle(probe).color.match(/\d+/g)!.map(Number);
        probe.remove();
        return [r!, g!, b!];
      };
      const img = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
      const ctx = new OffscreenCanvas(img.width, img.height).getContext("2d")!;
      ctx.drawImage(img, 0, 0);
      const head = ctx.getImageData(0, 0, img.width, headPx - 2).data;
      let ink = 0;
      for (let i = 0; i < head.length; i += 4) {
        if (head[i] !== head[0] || head[i + 1] !== head[1] || head[i + 2] !== head[2]) ink++;
      }
      const body = ctx.getImageData(0, headPx, img.width, chartPx).data;
      const count = ([r, g, b]: number[]) => {
        let n = 0;
        for (let i = 0; i < body.length; i += 4) {
          if (Math.abs(body[i]! - r!) <= 2 && Math.abs(body[i + 1]! - g!) <= 2 && Math.abs(body[i + 2]! - b!) <= 2) n++;
        }
        return n;
      };
      return { head: ink / (head.length / 4), up: count(rgb("--up")), down: count(rgb("--down")) };
    },
    { b64, headPx, chartPx },
  );
}

async function openSamsung(page: Page, scenario: Scenario, name = "삼성전자"): Promise<Locator> {
  await recordComposedText(page);
  if (name !== "삼성전자") {
    await page.route("**/api/symbols/005930", async (route) => {
      const response = await scenario.respond(route.request());
      await route.fulfill({ status: response.status ?? 200, json: { ...scenario.market.symbols.find(value => value.code === "005930"), name } });
    });
  }
  await page.goto("/?symbol=005930");
  await expect(cell(page)).toHaveAttribute("aria-label", `칸 1: ${name} 통합 일`);
  const chart = chartOf(cell(page));
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await expect(chart).not.toHaveAttribute("data-bar-count", "0");
  return chart;
}

async function expectSnapshotImage(page: Page, png: Buffer, chart: Locator): Promise<{ lines: number; drawn: DrawnText[] }> {
  const box = (await chart.boundingBox())!;
  const dpr = await page.evaluate(() => devicePixelRatio);
  const size = pngSize(png);
  expect(size.width).toBe(Math.round(box.width * dpr));
  const chartPx = Math.round(box.height * dpr);
  const footPx = Math.round(FOOT_HEIGHT * dpr);
  const headPx = size.height - chartPx - footPx;
  const lines = (headPx / dpr - HEAD_PAD) / HEAD_LINE;
  expect(Number.isInteger(lines), `머리 띠 줄 수 ${lines}`).toBe(true);

  const ink = await measureInk(page, png.toString("base64"), headPx, chartPx);
  expect(ink.head, "머리 띠의 글자 화소 비율").toBeGreaterThan(0.01);
  expect(ink.up, "차트 영역의 상승 봉 화소").toBeGreaterThan(100);
  expect(ink.down, "차트 영역의 하락 봉 화소").toBeGreaterThan(100);

  const drawn = await takeComposedText(page);
  expectNoOverlap(drawn, box.width);
  const credit = drawn.find((t) => t.text === CREDIT);
  expect(credit, "라이브러리 표기").toBeDefined();
  expect(credit!.x + credit!.w).toBeCloseTo(box.width - PAD_X, 0);
  expect(credit!.y).toBeGreaterThan(headPx / dpr + box.height);
  return { lines, drawn };
}

async function expectSnapshot(page: Page, download: Download, chart: Locator, headLines: (n: number) => boolean = (n) => n === 3) {
  expect(download.suggestedFilename()).toMatch(/^005930_combined_D_\d{8}-\d{4}\.png$/);
  const png = await readFile((await download.path())!);
  const { lines, drawn } = await expectSnapshotImage(page, png, chart);
  expect(headLines(lines), `머리 띠 줄 수 ${lines}`).toBe(true);
  return { png, drawn };
}

async function readClipboardPng(page: Page): Promise<Buffer | null> {
  const b64 = await page.evaluate(async () => {
    const item = (await navigator.clipboard.read()).find((i) => i.types.includes("image/png"));
    if (!item) return null;
    const bytes = new Uint8Array(await (await item.getType("image/png")).arrayBuffer());
    let s = "";
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s);
  });
  return b64 === null ? null : Buffer.from(b64, "base64");
}

const download = (page: Page, chart: Locator, act: () => Promise<void>, headLines?: (n: number) => boolean) =>
  Promise.all([page.waitForEvent("download"), act()]).then(([d]) => expectSnapshot(page, d, chart, headLines));

test.describe("데스크톱", () => {
  test("위 막대 버튼과 Alt+S로 머리가 붙은 차트 PNG를 내려받는다", async ({ scenario, page }, testInfo) => {
    const chart = await openSamsung(page, scenario);
    const button = page.getByRole("toolbar", { name: "차트 도구 막대" }).getByRole("button", { name: "차트 이미지 내려받기" });

    const { png, drawn } = await download(page, chart, () => button.click());
    await testInfo.attach("snapshot-desktop.png", { body: png, contentType: "image/png" });
    expect(drawn.map((t) => t.text), "기본 거래량 지표 줄").toContain("거래량");

    await chart.click();
    await download(page, chart, () => page.keyboard.press("Alt+KeyS"));
  });

  test("복사 버튼은 같은 PNG를 클립보드에 넣는다", async ({ scenario, page, context, baseURL }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: baseURL });
    const chart = await openSamsung(page, scenario);
    await page.getByRole("toolbar", { name: "차트 도구 막대" }).getByRole("button", { name: "차트 이미지 복사" }).click();
    await expect(page.getByText("차트 이미지를 클립보드에 복사했습니다")).toBeVisible();

    const png = await readClipboardPng(page);
    expect(png, "클립보드의 PNG").not.toBeNull();
    expect((await expectSnapshotImage(page, png!, chart)).lines).toBe(3);
  });
});

test.describe("휴대폰 390px", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("머리의 버튼으로 내려받기만 한다", async ({ scenario, page }, testInfo) => {
    const chart = await openSamsung(page, scenario);
    await expect(page.getByRole("button", { name: "차트 이미지 복사" })).toBeHidden();
    const [d] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "차트 이미지 내려받기" }).click()]);
    const { png } = await expectSnapshot(page, d, chart, (n) => n >= 3);
    await testInfo.attach("snapshot-phone.png", { body: png, contentType: "image/png" });
  });

  test("복사 단축키는 쓰지 않는다", async ({ scenario, page, context, baseURL }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: baseURL });
    const chart = await openSamsung(page, scenario);
    await page.evaluate(() => navigator.clipboard.writeText("before"));
    await chart.click();
    await page.keyboard.press("Alt+Shift+KeyS");
    await download(page, chart, () => page.keyboard.press("Alt+KeyS"), (n) => n >= 3);

    await expect(page.getByText("차트 이미지를 클립보드에 복사했습니다")).toBeHidden();
    expect(await readClipboardPng(page)).toBeNull();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("before");
  });

  test("긴 종목 이름도 시각과 겹치지 않는다", async ({ scenario, page }, testInfo) => {
    const chart = await openSamsung(page, scenario, LONG_NAME);
    const { png, drawn } = await download(page, chart, () => page.getByRole("button", { name: "차트 이미지 내려받기" }).click(), (n) => n >= 3);
    expect(drawn.map((t) => t.text)).toContain(LONG_NAME);
    await testInfo.attach("snapshot-phone-long-name.png", { body: png, contentType: "image/png" });
  });
});

test.describe("휴대폰 320px", () => {
  test.use({ viewport: { width: 320, height: 700 } });

  test("한 줄보다 긴 종목 이름은 줄여서 폭 안에 그린다", async ({ scenario, page }) => {
    const chart = await openSamsung(page, scenario, `${LONG_NAME}(합성 H) 액티브`);
    const { drawn } = await download(page, chart, () => page.getByRole("button", { name: "차트 이미지 내려받기" }).click(), (n) => n >= 3);
    const name = drawn.find((t) => t.text.startsWith("TIGER"));
    expect(name?.text).toMatch(/^TIGER .+…$/);
  });
});
