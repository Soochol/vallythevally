import type { Page } from "@playwright/test";
import type { Watchlists } from "../src/api/generated/Watchlists";
import { type App, cell, chartOf, expect, test } from "./harness";

test.use({ clockStart: "20261109100000" });

const panel = (page: Page) => page.getByRole("complementary", { name: "관심종목" });
const row = (page: Page, code: string) => panel(page).locator(`li[data-code="${code}"]`);

function trade(hhmmss: string, price: number, change: number, cumulative: number, exchange: "KRX" | "NXT"): Record<string, string> {
  const signed = (n: number) => (n < 0 ? `${n}` : `+${n}`);
  return { "20": hhmmss, "10": signed(price), "15": "+3", "13": String(cumulative), "9081": exchange, "11": signed(change), "12": "+0.00", "25": change < 0 ? "5" : "2" };
}

async function putWatchlist(page: Page, symbols: string[]) {
  const current = (await (await page.request.get("/api/watchlists")).json()) as Watchlists;
  const lists = current.lists.map((l, i) => (i === 0 ? { ...l, symbols } : l));
  const res = await page.request.put("/api/watchlists", { data: { lists, revision: current.revision + 1 } });
  expect(res.ok()).toBe(true);
}

function countQuoteRequests(page: Page): string[] {
  const urls: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/api/quotes")) urls.push(r.url());
  });
  return urls;
}

const places = async (app: App) => {
  const reg = await app.fake.registered();
  return (reg["0B"]?.length ?? 0) + (reg["0J"]?.length ?? 0);
};

test("체결이 관심종목 줄과 통합 칸 종가를 함께 바꾸고, REST는 처음 한 번만 부른다", async ({ page, app }) => {
  await putWatchlist(page, ["005930"]);
  const quoteRequests = countQuoteRequests(page);
  await page.goto("/?symbol=005930");
  const chart = chartOf(cell(page));
  const button = row(page, "005930").locator("[data-main]");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await expect(button).toHaveAccessibleName("삼성전자 50,000 −1.96%");
  await expect.poll(async () => (await app.fake.registered())["0B"] ?? []).toContain("005930_AL");

  await expect(async () => {
    await app.fake.pushReal("0B", "005930_AL", trade("100001", 51_500, 500, 1_300_000, "KRX"));
    await expect(chart).toHaveAttribute("data-last-close", "51500", { timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
  await expect(button).toHaveAccessibleName("삼성전자 51,500 +0.98%");

  await app.fake.pushReal("0B", "005930_AL", trade("100002", -49_800, -1_200, 1_420_000, "NXT"));
  await expect(chart).toHaveAttribute("data-last-close", "49800");
  await expect(button).toHaveAccessibleName("삼성전자 49,800 −2.35%");
  expect(quoteRequests).toHaveLength(1);
});

test.describe("실시간 자리가 모자라면", () => {
  test.use({ extraKospiStocks: 199 });

  test("목록 아래 줄은 처음 값에 실시간 아님을 보이고 다시 묻지 않으며, 위의 줄이 빠지면 실시간으로 돌아온다", async ({ page, app }) => {
    const synthetic = Array.from({ length: 199 }, (_, i) => String(950_000 + i * 10));
    await putWatchlist(page, [...synthetic, "005930"]);
    const quoteRequests = countQuoteRequests(page);
    await page.goto("/");
    await expect(panel(page).locator("li[data-code]")).toHaveCount(200);
    await expect.poll(() => places(app), { message: "코스피 칸 1자리 + 합성 199자리" }).toBe(200);

    const button = row(page, "005930").locator("[data-main]");
    await expect(button).toHaveAccessibleName("삼성전자 50,000 −1.96% 실시간 아님");
    await expect(row(page, "005930")).toContainText("실시간 아님");
    expect((await app.fake.registered())["0B"]).not.toContain("005930_AL");

    const first = row(page, synthetic[0]!);
    await first.click({ button: "right" });
    await page.getByRole("menuitem", { name: "관심종목에서 빼기" }).click();
    await expect(button).toHaveAccessibleName("삼성전자 50,000 −1.96%");
    await expect(row(page, "005930")).not.toContainText("실시간 아님");
    await expect.poll(async () => (await app.fake.registered())["0B"] ?? []).toContain("005930_AL");
    expect(quoteRequests).toHaveLength(1);
  });
});
