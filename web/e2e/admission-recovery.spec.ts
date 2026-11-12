import { selectOption } from "./select-option";
import type { Page } from "@playwright/test";
import { parseJournalRecord, STAGING_PREFIX } from "../src/chart/drawings/journal";
import { parseDrawingBody } from "../src/chart/drawings/outbox";
import { test, expect, cell, chartOf, type App } from "./harness";

const mirror = (page: Page) => chartOf(cell(page)).locator(".drawing-mirror");
const width = (page: Page) => page.getByRole("toolbar", { name: "드로잉 스타일" }).getByLabel("선 굵기");

async function drawings(app: App) {
  const response = await fetch(`${app.url}/api/drawings?symbol=IDX%3A001`);
  expect(response.status).toBe(200);
  const raw: unknown = await response.json();
  if (!Array.isArray(raw)) throw new Error("Expected the SQLite drawing list");
  return raw.map((item: unknown) => {
    const drawing = parseDrawingBody(item);
    if (drawing === null) throw new Error("Expected a valid persisted drawing");
    return drawing;
  });
}

async function open(page: Page) {
  await page.goto("/");
  await expect(chartOf(cell(page))).toHaveAttribute("data-bar-count", /^[1-9]\d*$/);
}

async function selectLine(page: Page) {
  await page.getByRole("button", { name: "개체 목록 열기" }).click();
  await page.getByRole("button", { name: "고르기: 수평선" }).click();
  await expect(width(page)).toBeVisible();
}

async function holdAdmission(page: Page, id: string) {
  await page.evaluate((drawingId) => new Promise<void>((acquired) => {
    void navigator.locks.request(`vv.drawing.journal.${drawingId}`, async () => {
      const released = new Promise<void>((resolve) => window.addEventListener("release-admission", () => resolve(), { once: true }));
      acquired();
      await released;
    });
  }), id);
}

async function blockDrawingTransport(page: Page) {
  await page.evaluate(() => {
    const nativeFetch = window.fetch;
    window.fetch = (input, init) => {
      if ((init?.method === "PUT" || init?.method === "DELETE") && String(input).includes("/api/drawings/")) {
        return new Promise<Response>(() => {});
      }
      return nativeFetch(input, init);
    };
  });
}

for (const edits of ["put", "delete", "put-put", "put-delete"] as const) {
  test(`drawing admission: ${edits} survives closing its tab behind another tab's lock`, async ({ page, context, app }, info) => {
    await open(page);
    const bounds = await chartOf(cell(page)).boundingBox();
    if (bounds === null) throw new Error("Expected the drawing chart");
    await cell(page).focus();
    await page.keyboard.press("H");
    await page.mouse.click(bounds.x + bounds.width * 0.75, bounds.y + bounds.height * 0.4);
    await expect.poll(async () => (await drawings(app)).length).toBe(1);
    const [original] = await drawings(app);
    if (original === undefined) throw new Error("Expected the seeded drawing");
    await expect(page.getByText(/^자동 저장됨 /)).toBeVisible();

    const editing = await context.newPage();
    await open(editing);
    await expect(mirror(editing)).toHaveAttribute("data-drawings", new RegExp(original.id));
    await selectLine(editing);
    await blockDrawingTransport(editing);
    await holdAdmission(page, original.id);
    try {
      if (edits !== "delete") {
        await selectOption(width(editing), "3");
        await expect(width(editing)).toHaveAttribute("data-value", "3");
      }
      if (edits === "put-put") {
        await selectOption(width(editing), "4");
        await expect(width(editing)).toHaveAttribute("data-value", "4");
      }
      const deleted = edits === "delete" || edits === "put-delete";
      if (deleted) {
        await editing.getByRole("button", { name: "드로잉 지우기", exact: true }).click();
        await expect(mirror(editing)).toHaveAttribute("data-drawings", "[]");
      }
      const pending = await editing.evaluate((prefix) => Object.keys(localStorage).filter((key) => key.startsWith(prefix)).map((key) => JSON.parse(localStorage.getItem(key) ?? "null")), STAGING_PREFIX);
      expect(pending).toHaveLength(edits.includes("-") ? 2 : 1);
      const intents = pending.map((value: unknown) => parseJournalRecord(value));
      expect(intents.every((intent) => intent?.id === original.id)).toBe(true);
      const locks = await page.evaluate(() => navigator.locks.query());
      expect(locks.pending?.some((lock) => lock.name === `vv.drawing.journal.${original.id}`)).toBe(true);
      await info.attach("admission-lock.json", {
        body: JSON.stringify({ locks, intents }, null, 2),
        contentType: "application/json",
      });
      expect(await drawings(app)).toEqual([original]);
      await editing.close();
      await page.evaluate(() => window.dispatchEvent(new Event("release-admission")));

      const recovered = await context.newPage();
      await open(recovered);
      if (deleted) {
        await expect.poll(() => drawings(app)).toEqual([]);
        await expect(mirror(recovered)).toHaveAttribute("data-drawings", "[]");
      } else {
        const expectedWidth = edits === "put-put" ? 4 : 3;
        await expect.poll(async () => (await drawings(app))[0]?.style).toMatchObject({ line: { width: expectedWidth } });
        await selectLine(recovered);
        await expect(width(recovered)).toHaveAttribute("data-value", String(expectedWidth));
      }
      const saved = await drawings(app);
      await app.restart();
      expect(await drawings(app)).toEqual(saved);
      await recovered.reload();
      await expect(chartOf(cell(recovered))).toHaveAttribute("data-bar-count", /^[1-9]\d*$/);
      await expect(mirror(recovered)).toHaveAttribute("data-drawings", deleted ? "[]" : new RegExp(original.id));
    } finally {
      await page.evaluate(() => window.dispatchEvent(new Event("release-admission")));
    }
  });
}
