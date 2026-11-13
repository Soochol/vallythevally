import type { Page } from "@playwright/test";
import { parseDrawingBody, recordKey } from "../src/chart/drawings/outbox";
import { parseJournalRecord } from "../src/chart/drawings/journal";
import { test, expect, cell, chartOf, type Scenario } from "./harness";

const mirror = (page: Page) => chartOf(cell(page)).locator(".drawing-mirror");

async function open(page: Page, url: string) {
  const loaded = page.waitForResponse((response) => response.url().includes("/api/drawings?") && response.request().method() === "GET");
  await page.goto(url);
  await (await loaded).finished();
  await expect(chartOf(cell(page))).toHaveAttribute("data-bar-count", /^[1-9]\d*$/);
  await expect(mirror(page)).toHaveAttribute("data-drawings", "[]");
}

async function drawings(scenario: Scenario) {
  const response = scenario.documents.drawings("IDX:001");
  const raw: unknown = response;
  if (!Array.isArray(raw)) throw new Error("Expected the stored drawing list");
  return raw.map((item: unknown) => {
    const drawing = parseDrawingBody(item);
    if (drawing === null) throw new Error("Expected a valid stored drawing");
    return drawing;
  });
}

async function journal(page: Page, id: string) {
  const raw = await page.evaluate((key) => localStorage.getItem(key), recordKey(id));
  return raw === null ? null : parseJournalRecord(JSON.parse(raw));
}

for (const offset of [0, -60_000]) {
  test(`failed DELETE survives another tab's old PUT acknowledgement with clock offset ${offset}`, async ({ page, scenario }, info) => {
    const other = await page.context().newPage();
    await open(page, "/");
    await open(other, "/");
    const now = Date.now();
    await page.evaluate((time) => { Date.now = () => time; }, now);

    let release = () => {};
    const acknowledgement = new Promise<void>((resolve) => { release = resolve; });
    let accepted = false;
    await page.route("**/api/drawings/*", async (route) => {
      if (route.request().method() !== "PUT") return route.fallback();
      const response = await scenario.respond(route.request());
      expect((response.status ?? 200)).toBe(200);
      accepted = true;
      await acknowledgement;
      await route.fulfill({ status: response.status ?? 200, json: response.body, headers: response.headers });
    });

    try {
      const bounds = await chartOf(cell(page)).boundingBox();
      if (bounds === null) throw new Error("Expected the drawing chart");
      await cell(page).focus();
      await page.keyboard.press("H");
      await page.mouse.click(bounds.x + bounds.width * 0.75, bounds.y + bounds.height * 0.4);
      await expect.poll(() => accepted).toBe(true);
      const [created] = await drawings(scenario);
      if (created === undefined) throw new Error("The held PUT must reach SQLite before deletion");
      expect(created.revision).toBe(now);
      expect((await journal(other, created.id))?.want.kind).toBe("put");

      await other.bringToFront();
      const refreshed = other.waitForResponse((response) => response.url().includes("/api/drawings?") && response.request().method() === "GET");
      await other.evaluate(() => window.dispatchEvent(new Event("focus")));
      await (await refreshed).finished();
      await expect(mirror(other)).toHaveAttribute("data-drawings", new RegExp(created.id));
      await other.evaluate((time) => { Date.now = () => time; }, now + offset);

      let replayedDeletes = 0;
      other.on("request", (request) => {
        if (request.method() === "DELETE" && request.url().includes("/api/drawings/")) replayedDeletes++;
      });
      await other.evaluate(() => {
        const nativeFetch = window.fetch;
        let blocked = 0;
        window.fetch = (input, init) => {
          if (init?.method === "DELETE" && String(input).includes("/api/drawings/")) {
            document.documentElement.dataset.blockedDrawingDeletes = String(++blocked);
            return Promise.reject(new TypeError("Connection lost before DELETE reaches the server"));
          }
          return nativeFetch(input, init);
        };
      });
      await other.getByRole("button", { name: "개체 목록 열기" }).click();
      await other.getByRole("button", { name: "고르기: 수평선" }).click();
      await other.getByRole("button", { name: "드로잉 지우기", exact: true }).click();
      await expect(other.locator("html")).toHaveAttribute("data-blocked-drawing-deletes", /^[1-9]\d*$/);
      await expect(mirror(other)).toHaveAttribute("data-drawings", "[]");
      expect((await drawings(scenario)).map((drawing) => drawing.id)).toContain(created.id);
      const beforeAck = await journal(other, created.id);
      expect.soft(beforeAck?.want.kind, "the later unsent DELETE must replace the pending PUT journal").toBe("delete");

      release();
      await expect(page.getByText(/^자동 저장됨 /)).toBeVisible();
      const afterAck = await journal(other, created.id);
      expect.soft(afterAck?.want.kind, "the old PUT acknowledgement must preserve the newer DELETE journal").toBe("delete");
      await info.attach("journal-order.json", {
        body: JSON.stringify({ offset, created, beforeAck, afterAck }, null, 2),
        contentType: "application/json",
      });

      await other.reload();
      await expect(chartOf(cell(other))).toHaveAttribute("data-bar-count", /^[1-9]\d*$/);
      await expect.soft.poll(() => replayedDeletes, { message: "the new document must replay the recovered DELETE" }).toBeGreaterThan(0);
      await expect.soft.poll(async () => (await drawings(scenario)).map((drawing) => drawing.id), {
        message: "reloading the deleting tab must replay its DELETE to SQLite",
      }).not.toContain(created.id);
      await expect.soft(mirror(other)).toHaveAttribute("data-drawings", "[]");
      await expect.soft.poll(() => journal(other, created.id)).toBeNull();
    } finally {
      release();
    }
  });
}
