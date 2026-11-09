import { readFile } from "node:fs/promises";
import type { Download, Locator, Page } from "@playwright/test";
import { cell, chartOf, expect, test } from "./harness";

const HEAD_LINE = 22;
const HEAD_PAD = 12;
const HEAD_HEIGHT = 2 * HEAD_LINE + HEAD_PAD;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function pngSize(bytes: Buffer): { width: number; height: number } {
  expect([...bytes.subarray(0, 8)]).toEqual(PNG_SIGNATURE);
  expect(bytes.subarray(12, 16).toString("ascii")).toBe("IHDR");
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

async function headInkRatio(page: Page, png: Buffer): Promise<number> {
  return page.evaluate(
    async ({ b64, head }) => {
      const img = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
      const canvas = new OffscreenCanvas(img.width, img.height);
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(img, 0, 0);
      const { data } = ctx.getImageData(0, 0, img.width, head - 2);
      let ink = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i] !== data[0] || data[i + 1] !== data[1] || data[i + 2] !== data[2]) ink++;
      }
      return ink / (data.length / 4);
    },
    { b64: png.toString("base64"), head: HEAD_HEIGHT },
  );
}

async function openSamsung(page: Page): Promise<Locator> {
  await page.goto("/?symbol=005930");
  await expect(cell(page)).toHaveAttribute("aria-label", "칸 1: 삼성전자 통합 일");
  const chart = chartOf(cell(page));
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await expect(chart).not.toHaveAttribute("data-bar-count", "0");
  return chart;
}

async function expectSnapshot(page: Page, download: Download, chart: Locator, headLines: (n: number) => boolean = (n) => n === 2) {
  expect(download.suggestedFilename()).toMatch(/^005930_combined_D_\d{8}-\d{4}\.png$/);
  const png = await readFile((await download.path())!);
  const box = (await chart.boundingBox())!;
  const dpr = await page.evaluate(() => devicePixelRatio);
  const size = pngSize(png);
  expect(size.width).toBe(Math.round(box.width * dpr));
  const lines = ((size.height - Math.round(box.height * dpr)) / dpr - HEAD_PAD) / HEAD_LINE;
  expect(Number.isInteger(lines) && headLines(lines), `머리 띠 줄 수 ${lines}`).toBe(true);
  expect(await headInkRatio(page, png)).toBeGreaterThan(0.01);
  return png;
}

test.describe("데스크톱", () => {
  test("위 막대 버튼과 Alt+S로 머리가 붙은 차트 PNG를 내려받는다", async ({ page }, testInfo) => {
    const chart = await openSamsung(page);
    const button = page.getByRole("toolbar", { name: "차트 도구 막대" }).getByRole("button", { name: "차트 이미지 내려받기" });

    const [byButton] = await Promise.all([page.waitForEvent("download"), button.click()]);
    const png = await expectSnapshot(page, byButton, chart);
    await testInfo.attach("snapshot-desktop.png", { body: png, contentType: "image/png" });

    await chart.click();
    const [byKey] = await Promise.all([page.waitForEvent("download"), page.keyboard.press("Alt+KeyS")]);
    await expectSnapshot(page, byKey, chart);
  });

  test("복사 버튼은 같은 PNG를 클립보드에 넣는다", async ({ page, context, baseURL }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: baseURL });
    const chart = await openSamsung(page);
    await page.getByRole("toolbar", { name: "차트 도구 막대" }).getByRole("button", { name: "차트 이미지 복사" }).click();
    await expect(page.getByText("차트 이미지를 클립보드에 복사했습니다")).toBeVisible();

    const copied = await page.evaluate(async () => {
      const [item] = await navigator.clipboard.read();
      const bytes = new Uint8Array(await (await item!.getType("image/png")).arrayBuffer());
      return btoa(String.fromCharCode(...bytes.subarray(0, 24)));
    });
    const box = (await chart.boundingBox())!;
    expect(pngSize(Buffer.from(copied, "base64"))).toEqual({ width: Math.round(box.width), height: Math.round(box.height) + HEAD_HEIGHT });
  });
});

test.describe("휴대폰 390px", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("머리의 버튼으로 내려받기만 한다", async ({ page }, testInfo) => {
    const chart = await openSamsung(page);
    await expect(page.getByRole("button", { name: "차트 이미지 복사" })).toBeHidden();
    const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "차트 이미지 내려받기" }).click()]);
    const png = await expectSnapshot(page, download, chart, (n) => n >= 3);
    await testInfo.attach("snapshot-phone.png", { body: png, contentType: "image/png" });
  });
});
