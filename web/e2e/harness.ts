import { test as base, expect, type Locator, type Page } from "@playwright/test";
import { DEFAULT_LAYOUT_ID, Scenario } from "./fixtures/scenario";
export { DEFAULT_LAYOUT_ID, firstChart, withFirstChart, type Scenario } from "./fixtures/scenario";

function cpuThrottleRate(): number | null {
  const raw = process.env.VALLY_E2E_CPU_THROTTLE;
  if (raw === undefined || raw === "") return null;
  const rate = Number(raw);
  if (!Number.isFinite(rate) || rate < 1) throw new Error(`VALLY_E2E_CPU_THROTTLE는 1 이상의 수여야 한다: ${JSON.stringify(raw)}`);
  return rate;
}

export const test = base.extend<{ scenario: Scenario; clockStart: string | null }>({
  clockStart: [null, { option: true }],
  scenario: [async ({ context, clockStart }, use) => {
    const now = clockStart ? Date.parse(`${clockStart.slice(0,4)}-${clockStart.slice(4,6)}-${clockStart.slice(6,8)}T${clockStart.slice(8,10)}:${clockStart.slice(10,12)}:${clockStart.slice(12,14)}+09:00`) : undefined;
    const scenario = new Scenario(now);
    scenario.on("/api/book-replay/access", () =>
      scenario.publicMode.kind === "public"
        ? { status: 404, body: { error: { code: "not_found", message: "공개 리스너에 없는 경로입니다", reason: null, retryAt: null, manualActionRequired: false } } }
        : { body: { available: false } },
    );
    scenario.on(
      (url) => /^\/api\/symbols\/[^/]+\/book-replay\/days$/.test(url.pathname),
      (request) => {
        if (scenario.publicMode.kind === "public") {
          return { status: 404, body: { error: { code: "not_found", message: "공개 리스너에 없는 경로입니다", reason: null, retryAt: null, manualActionRequired: false } } };
        }
        const symbol = decodeURIComponent(new URL(request.url()).pathname.split("/")[3] ?? "");
        return { body: { symbol, days: [] } };
      },
    );
    scenario.on(
      (url) => /^\/api\/symbols\/[^/]+\/brokers\/days$/.test(url.pathname),
      (request) => {
        if (scenario.publicMode.kind === "public") {
          return { status: 404, body: { error: { code: "not_found", message: "공개 리스너에 없는 경로입니다", reason: null, retryAt: null, manualActionRequired: false } } };
        }
        const symbol = decodeURIComponent(new URL(request.url()).pathname.split("/")[3] ?? "");
        return { body: { symbol, days: [] } };
      },
    );
    scenario.on(
      (url) => /^\/api\/symbols\/[^/]+\/brokers$/.test(url.pathname),
      (request) => {
        if (scenario.publicMode.kind === "public") {
          return { status: 404, body: { error: { code: "not_found", message: "공개 리스너에 없는 경로입니다", reason: null, retryAt: null, manualActionRequired: false } } };
        }
        const url = new URL(request.url());
        const symbol = decodeURIComponent(url.pathname.split("/")[3] ?? "");
        return { body: { symbol, date: url.searchParams.get("date") ?? "", source: "none", snapshots: [], gaps: [], live: false, cursor: "", reset: true } };
      },
    );
    scenario.on(
      (url) => /^\/api\/symbols\/[^/]+\/vi-playbook$/.test(url.pathname),
      (request) => {
        if (scenario.publicMode.kind === "public") {
          return { status: 404, body: { error: { code: "not_found", message: "공개 리스너에 없는 경로입니다", reason: null, retryAt: null, manualActionRequired: false } } };
        }
        const url = new URL(request.url());
        const symbol = decodeURIComponent(url.pathname.split("/")[3] ?? "");
        const direction = url.searchParams.get("direction") === "down" ? "down" : "up";
        const kindParam = url.searchParams.get("kind");
        const kind = kindParam === "dynamic" || kindParam === "static" ? kindParam : "all";
        return { body: { symbol, direction, kind, lookbackDays: 0, sampleCount: 0, horizons: [], recentMatches: [] } };
      },
    );
    scenario.on(
      (url) => /^\/api\/symbols\/[^/]+\/micro-events$/.test(url.pathname),
      (request) => {
        if (scenario.publicMode.kind === "public") {
          return { status: 404, body: { error: { code: "not_found", message: "공개 리스너에 없는 경로입니다", reason: null, retryAt: null, manualActionRequired: false } } };
        }
        const url = new URL(request.url());
        const symbol = decodeURIComponent(url.pathname.split("/")[3] ?? "");
        return { body: { symbol, date: url.searchParams.get("date") ?? "", source: "none", events: [] } };
      },
    );
    scenario.on(
      (url) => /^\/api\/symbols\/[^/]+\/tick-cvd$/.test(url.pathname),
      (request) => {
        if (scenario.publicMode.kind === "public") {
          return { status: 404, body: { error: { code: "not_found", message: "공개 리스너에 없는 경로입니다", reason: null, retryAt: null, manualActionRequired: false } } };
        }
        const url = new URL(request.url());
        const symbol = decodeURIComponent(url.pathname.split("/")[3] ?? "");
        const period = url.searchParams.get("period") ?? "1m";
        return { body: { symbol, period, state: "disabled", points: [] } };
      },
    );
    scenario.on(
      (url) => /^\/api\/symbols\/[^/]+\/program-series$/.test(url.pathname),
      (request) => {
        if (scenario.publicMode.kind === "public") {
          return { status: 404, body: { error: { code: "not_found", message: "공개 리스너에 없는 경로입니다", reason: null, retryAt: null, manualActionRequired: false } } };
        }
        const url = new URL(request.url());
        const symbol = decodeURIComponent(url.pathname.split("/")[3] ?? "");
        const period = url.searchParams.get("period") ?? "1m";
        return { body: { symbol, period, state: "disabled", points: [] } };
      },
    );
    const throttle = cpuThrottleRate();
    if (throttle !== null) {
      const apply = async (page: Page) => { await (await context.newCDPSession(page)).send("Emulation.setCPUThrottlingRate", { rate: throttle }); };
      context.on("page", page => { apply(page).catch(() => {}); });
      await Promise.all(context.pages().map(apply));
    }
    await scenario.install(context);
    try { await use(scenario); } finally { await scenario.close(); }
  }, { auto: true }],
});
export { expect };

export const pollSaved = <T>(generator: () => T | Promise<T>, options: { message?: string; timeout?: number } = {}) => expect.poll(generator, { ...options, intervals: [50] });

export const SEARCH_BUTTON_TITLE = "종목 검색 (/ 또는 Ctrl+K)";

export const cell = (page: Page, n = 1): Locator => page.getByRole("region", { name: new RegExp(`^칸 ${n}: `) });

export const windowTabs = (page: Page): Locator => page.getByRole("tablist", { name: /^창 묶음 / });

export const windowTab = (page: Page, name: string): Locator => windowTabs(page).getByRole("tab", { name: new RegExp(`^${name}`) });

export function saveChartShare(scenario: Scenario, ratio: number): void {
  const layout = scenario.documents.layout(DEFAULT_LAYOUT_ID);
  const side = layout.windows.filter((w) => w.kind !== "chart").map((w) => w.id);
  const chart = layout.windows.find((w) => w.kind === "chart")!.id;
  const root = { kind: "split", dir: "row", ratio, first: { kind: "group", id: "g1", tabs: [chart], active: chart }, second: { kind: "group", id: "g2", tabs: side, active: side[0] } };
  scenario.documents.saveLayout({ ...layout, revision: layout.revision + 1, placement: { v: 1, dock: { root, floats: [] }, canvas: null } });
}

export const chartOf = (c: Locator): Locator => c.locator("[data-bar-count]");

export async function barTimes(chart: Locator): Promise<{ count: number; first: number }> {
  const [count, first] = await Promise.all([chart.getAttribute("data-bar-count"), chart.getAttribute("data-first-bar-t")]);
  return { count: Number(count), first: Number(first) };
}

export async function dragTowardPast(page: Page, chart: Locator, until: () => Promise<void>): Promise<void> {
  await expect(async () => {
    const box = await chart.boundingBox();
    if (!box) throw new Error("차트가 보이지 않습니다");
    const y = box.y + box.height / 2;
    await page.mouse.move(box.x + box.width * 0.3, y);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.9, y, { steps: 12 });
    await page.mouse.up();
    await until();
  }).toPass({ timeout: 30_000, intervals: [0] });
}

const VENUE_VALUE = { "통합": "combined", KRX: "krx", NXT: "nxt" } as const;
export type VenueName = keyof typeof VENUE_VALUE;

export const desktopVenueCombo = (page: Page): Locator => page.getByRole("combobox", { name: "거래소", exact: true });

export async function pickDesktopVenue(page: Page, venue: VenueName): Promise<void> {
  await desktopVenueCombo(page).click();
  await page.getByRole("menu", { name: "거래소", exact: true }).locator(`[data-option-value="${VENUE_VALUE[venue]}"]`).click();
}

export const expectDesktopVenue = (page: Page, venue: VenueName) => expect(desktopVenueCombo(page)).toHaveAttribute("data-value", VENUE_VALUE[venue]);

export async function fixedWait(page: Page, ms: number, reason: string): Promise<void> {
  if (!reason.trim()) throw new Error("fixedWait에는 이유가 필요합니다");
  test.info().annotations.push({ type: "fixed-wait", description: `${ms}ms ${reason}` });
  await page.waitForTimeout(ms);
}
