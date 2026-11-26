import type { Page } from "@playwright/test";
import type { HeatmapThemes } from "../src/api/generated/HeatmapThemes";
import { boardOf } from "../dev/fakeHeatmapBoard";
import { HEATMAP_NAMES, heatmapQuote, QUOTED_AT, type HeatmapTable } from "./fixtures/heatmap-data";
import { expect, pollSaved, test, type Scenario } from "./harness";

test.use({ clockStart: "20261109100000", viewport: { width: 1440, height: 900 } });

const main = (page: Page) => page.getByRole("main", { name: "히트맵", exact: true });
const tile = (page: Page, code: string) => main(page).locator(`.hm-tile[data-code="${code}"]`);

const THEME_NAMES = ["반도체", "2차전지", "자동차", "바이오", "금융지주", "인터넷", "조선", "방산"];
const STOCK_NAMES = [
  "삼성전자", "SK하이닉스", "한미반도체", "리노공업", "이오테크닉스", "DB하이텍", "주성엔지니어링", "원익IPS", "테크윙",
  "LG에너지솔루션", "삼성SDI", "포스코퓨처엠", "에코프로비엠", "엘앤에프", "솔브레인", "천보", "SK아이이테크놀로지", "대주전자재료",
  "현대차", "기아", "현대모비스", "HL만도", "한온시스템", "현대위아", "에스엘", "화신", "세종공업",
  "삼성바이오로직스", "셀트리온", "유한양행", "한미약품", "알테오젠", "HLB", "녹십자", "종근당", "대웅제약",
  "KB금융", "신한지주", "하나금융지주", "우리금융지주", "메리츠금융지주", "한국금융지주", "BNK금융지주", "JB금융지주", "DGB금융지주",
  "NAVER", "카카오", "크래프톤", "엔씨소프트", "넷마블", "펄어비스", "더존비즈온", "카카오뱅크", "카카오페이",
  "HD한국조선해양", "삼성중공업", "한화오션", "HD현대미포", "HD현대중공업", "한화엔진", "STX엔진", "케이조선", "대한조선",
  "한화에어로스페이스", "LIG넥스원", "한국항공우주", "현대로템", "풍산", "빅텍", "휴니드", "스페코", "퍼스텍",
];
const CODES = STOCK_NAMES.map((_, i) => String(100_001 + i));

function wideThemes(): HeatmapThemes {
  return { revision: 100, themes: THEME_NAMES.map((name, i) => ({ id: `theme-${i}`, name, symbols: CODES.slice(i * 9, i * 9 + 9) })) };
}

function wideTable(): HeatmapTable {
  return Object.fromEntries(CODES.map((code, i) => [code, { rate: Math.round((((i * 37) % 21) - 10) * 0.7 * 100) / 100, traded: 5_000 + ((i * 7919) % 90_000) }]));
}

function seedWideBoard(scenario: Scenario, table: HeatmapTable): string[] {
  const asked: string[] = [];
  scenario.documents.saveHeatmapThemes(wideThemes());
  scenario.on("/api/quotes", (request) => {
    const symbols = (new URL(request.url()).searchParams.get("symbols") ?? "").split(",");
    return { body: symbols.flatMap((symbol) => (table[symbol] ? [heatmapQuote(symbol, table[symbol])] : [])) };
  });
  scenario.on("/api/heatmap/board", (request) => {
    asked.push(request.url());
    const memberOf = (code: string) => {
      const row = table[code];
      return row ? { symbol: code, name: STOCK_NAMES[CODES.indexOf(code)] ?? HEATMAP_NAMES[code] ?? code, changeRate: row.rate, tradedMillionWon: row.traded } : null;
    };
    return { body: boardOf(scenario.documents.heatmapThemes(), memberOf, "rate", QUOTED_AT) };
  });
  return asked;
}

const boardError = { error: { code: "internal", message: "보드를 만들지 못했습니다", reason: null, retryAt: null, manualActionRequired: false } };

async function countTileRenders(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const seen = new WeakMap<object, unknown>();
    const counts: Record<string, number> = {};
    const w = window as unknown as Record<string, unknown>;
    w.__tileRenders = counts;
    const noop = () => undefined;
    w.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
      supportsFiber: true,
      renderers: new Map(),
      inject: () => 1,
      checkDCE: noop,
      onCommitFiberUnmount: noop,
      onScheduleFiberRoot: noop,
      onPostCommitFiberRoot: noop,
      onCommitFiberRoot: (_id: number, root: { current: unknown }) => {
        type Fiber = { child: Fiber | null; sibling: Fiber | null; return: Fiber | null; stateNode: unknown; memoizedProps: unknown };
        const start = root.current as Fiber;
        let fiber: Fiber | null = start;
        while (fiber) {
          const node = fiber.stateNode;
          if (node instanceof HTMLElement && node.classList.contains("hm-tile") && node.dataset.code) {
            if (seen.get(node) !== fiber.memoizedProps) {
              counts[node.dataset.code] = (counts[node.dataset.code] ?? 0) + 1;
              seen.set(node, fiber.memoizedProps);
            }
          }
          if (fiber.child) fiber = fiber.child;
          else {
            while (fiber && fiber !== start && !fiber.sibling) fiber = fiber.return;
            fiber = fiber && fiber !== start ? fiber.sibling : null;
          }
        }
      },
    };
  });
}

const renderCounts = (page: Page) => page.evaluate(() => ({ ...((window as unknown as { __tileRenders: Record<string, number> }).__tileRenders) }));
const resetCounts = (page: Page) => page.evaluate(() => {
  const counts = (window as unknown as { __tileRenders: Record<string, number> }).__tileRenders;
  for (const key of Object.keys(counts)) delete counts[key];
});
const settled = (page: Page) => page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));

test("보드 요청이 실패하면 다시 시도가 있는 상태 판을 보이고 누르면 다시 요청한다", async ({ page, scenario }) => {
  let asked = 0;
  scenario.on("/api/heatmap/board", () => {
    asked += 1;
    return { status: 503, body: boardError };
  });
  await page.goto("/heatmap");
  const alert = main(page).getByRole("alert");
  await expect(alert).toContainText("보드를 만들지 못했습니다");
  await expect(alert).toContainText("자동으로 다시 받습니다");
  const before = asked;
  await alert.getByRole("button", { name: "다시 시도" }).click();
  await pollSaved(() => asked).toBeGreaterThan(before);
});

test("보드 응답을 붙잡은 동안 그룹 뼈대가 보인다", async ({ page, scenario }) => {
  scenario.documents.saveHeatmapThemes(wideThemes());
  const held = scenario.hold("/api/heatmap/board");
  await page.goto("/heatmap");
  await held.received;
  await expect(main(page).getByRole("status", { name: "보드를 불러오는 중" })).toBeVisible();
  await expect(main(page).locator(".hm-tile")).toHaveCount(0);
  held.reply({ body: boardOf(scenario.documents.heatmapThemes(), () => null, "rate", QUOTED_AT) });
});

test("테마 여덟 개·종목 일흔두 개 보드에서 한 종목의 시세 프레임은 타일 하나만 다시 그린다", async ({ page, scenario }) => {
  const table = wideTable();
  seedWideBoard(scenario, table);
  await countTileRenders(page);
  await page.goto("/heatmap");
  await expect(main(page).locator(".hm-tile")).toHaveCount(72);
  const target = CODES[10]!;
  await pollSaved(() => scenario.live.messages.some((m) => m.type === "watch" && m.symbols.includes(target))).toBe(true);
  await settled(page);
  await resetCounts(page);
  table[target] = { rate: 9.5, traded: table[target]!.traded };
  scenario.live.emit({ type: "quotes", venue: "combined", quotes: [heatmapQuote(target, table[target]!, "realtime")] });
  await expect(tile(page, target)).toHaveAttribute("data-side", "up");
  await expect(tile(page, target)).toHaveAccessibleName(/\+9\.50%$/);
  await settled(page);
  const counts = await renderCounts(page);
  test.info().annotations.push({ type: "tile-renders", description: JSON.stringify({ total: Object.values(counts).reduce((a, b) => a + b, 0), tiles: Object.keys(counts).length }) });
  expect(Object.keys(counts)).toEqual([target]);
  expect(counts[target]).toBe(1);
});

test("1440×900에서 첫 타일의 위 끝은 y=220 이하이고 390×844에서는 y=300 이하다", async ({ page, scenario }) => {
  seedWideBoard(scenario, wideTable());
  await page.goto("/heatmap");
  await expect(tile(page, CODES[0]!)).toBeVisible();
  const top = async () => Math.min(...(await main(page).locator(".hm-tile").evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().y))));
  expect(await top()).toBeLessThanOrEqual(220);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(tile(page, CODES[0]!)).toBeVisible();
  expect(await top()).toBeLessThanOrEqual(300);
});

test("글자가 붙은 타일 가운데 이름이 말줄임된 것은 10% 이하다", async ({ page, scenario }) => {
  seedWideBoard(scenario, wideTable());
  await page.goto("/heatmap");
  await expect(main(page).locator(".hm-tile")).toHaveCount(72);
  const result = await main(page).locator(".hm-tile-name").evaluateAll((nodes) => ({
    labelled: nodes.length,
    clipped: nodes.filter((node) => node.scrollHeight > node.clientHeight + 1 || node.scrollWidth > node.clientWidth + 1).length,
  }));
  expect(result.labelled).toBeGreaterThan(0);
  expect(result.clipped / result.labelled).toBeLessThanOrEqual(0.1);
});

test("등락률순 배치에서 가로세로 비 4:1을 넘는 타일은 72개 중 4개 이하다", async ({ page, scenario }) => {
  seedWideBoard(scenario, wideTable());
  await page.goto("/heatmap?sort=rate");
  await expect(main(page).locator(".hm-tile")).toHaveCount(72);
  const stretched = await main(page).locator(".hm-tile").evaluateAll((nodes) => nodes.filter((node) => {
    const box = node.getBoundingClientRect();
    return Math.max(box.width / box.height, box.height / box.width) > 4;
  }).length);
  expect(stretched).toBeLessThanOrEqual(4);
});

test("390px 흐름 비교의 눈금 글자는 실제 11px 이상으로 그려진다", async ({ page, scenario }) => {
  seedWideBoard(scenario, wideTable());
  const flow = (rates: number[]) => ({ date: "2026-11-09", bucketMinutes: 5, points: rates.map((rate, i) => ({ t: 1_794_182_400 + i * 300, rate })), used: [], missing: [], overLimit: [], limit: 60 });
  scenario.on("/api/heatmap/flow", () => ({ body: flow([0.2, 0.9, 1.4, 1.1, 1.8]) }));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/heatmap?view=flow");
  const chart = main(page).locator(".hm-flow-chart");
  await expect(chart).toBeVisible();
  const box = (await chart.boundingBox())!;
  const viewBox = (await chart.getAttribute("viewBox"))!.split(" ").map(Number);
  expect(Math.abs(viewBox[2]! - box.width)).toBeLessThanOrEqual(1);
  const sizes = await chart.locator(".hm-flow-grid text, .hm-flow-hour").evaluateAll((nodes) => nodes.map((node) => parseFloat(getComputedStyle(node).fontSize)));
  expect(sizes.length).toBeGreaterThan(0);
  for (const size of sizes) expect(size).toBeGreaterThanOrEqual(11);
});

test("테마 편집은 모달 없이 페이지 안에서 멀티컬럼 시트로 열린다", async ({ page, scenario }) => {
  seedWideBoard(scenario, wideTable());
  await page.goto("/heatmap");
  await expect(main(page).locator(".hm-tile")).toHaveCount(72);
  await page.getByRole("button", { name: "테마 편집" }).click();
  await expect(page.getByRole("dialog", { name: "테마 편집" })).toHaveCount(0);
  const sheet = main(page).getByRole("region", { name: "테마 편집" });
  await expect(sheet).toBeVisible();
  await expect(sheet.locator(".hm-edit-col")).toHaveCount(8);
  const symBox = (await sheet.locator(".hm-edit-sym").first().boundingBox())!;
  expect(symBox.height).toBeLessThanOrEqual(28);
});
