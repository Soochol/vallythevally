import type { Page } from "@playwright/test";
import type { Screen } from "../src/api/generated/Screen";
import { cell, expect, SEARCH_BUTTON_TITLE, test, type Scenario, pollSaved } from "./harness";
import { expandDock } from "./drawing-probe";
import { openScreener, panel } from "./screener-page";
import { expandEditor, screenAction, sentenceEditor } from "./sentence-editor";

test.use({ viewport: { width: 1440, height: 900 } });

const toolbar = (page: Page) => page.getByRole("toolbar", { name: "차트 도구 막대" });
const SCREEN: Screen = { id: "seeded", name: "고가 60일 신고가", markets: ["kospi"], exclude: ["etf"], conditions: [{ kind: "new_high", period: "D", recentBars: 20, field: "high", n: 60 }, { kind: "market_cap", min: 300_000_000_000, max: null }] };

async function open(page: Page) {
  await page.goto("/?symbol=005930");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
}

function seedScreen(scenario: Scenario) {
  scenario.documents.saveScreens({ screens: [SCREEN], revision: 1 });
}

test("위 막대 가운데 검색창은 지금 종목을 보이며 눌러도 / 키로도 같은 검색 창을 열고 툴팁은 이름과 단축키를 나눠 보이며 마우스를 올린 동안 브라우저 기본 툴팁은 막는다", async ({ page }) => {
  await open(page);
  const search = toolbar(page).getByRole("button", { name: "종목·지표·명령 찾기", exact: true });
  await expect(search).toContainText("삼성전자");
  await expect(search).toContainText("005930");
  await search.click();
  await expect(page.getByRole("dialog", { name: "종목 검색", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(search).toBeFocused();
  await page.keyboard.press("/");
  await expect(page.getByRole("dialog", { name: "종목 검색", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.mouse.move(700, 450);
  await page.getByTitle(SEARCH_BUTTON_TITLE).click();
  await expect(page.getByRole("dialog", { name: "종목 검색", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  expect(await toolbar(page).evaluate((node) => node.scrollWidth - node.clientWidth)).toBe(0);

  const indicators = toolbar(page).getByRole("button", { name: "지표", exact: true });
  await indicators.hover();
  const tip = page.getByRole("tooltip");
  await expect(tip).toHaveText("지표I");
  await expect(tip.locator("kbd")).toHaveText("I");
  await expect(indicators).not.toHaveAttribute("title");
  await page.mouse.move(700, 450);
  await expect(tip).toHaveCount(0);
  await expect(indicators).toHaveAttribute("title", "지표 (I)");
  await indicators.focus();
  await expect(tip).toHaveText("지표I");
  await expect(indicators).toHaveAttribute("title", "지표 (I)");
});

test("조건 문장은 번호 배지와 알약 낱말로 보이고 지우기 확인 창은 무엇을 지우는지 버튼에 적는다", async ({ scenario, page }) => {
  seedScreen(scenario);
  await open(page);
  await openScreener(page);
  await expandEditor(page);
  const lines = panel(page).getByRole("list", { name: "조건", exact: true }).getByRole("listitem");
  await expect(lines).toHaveCount(2);
  expect(await lines.evaluateAll((items) => items.map((item) => getComputedStyle(item, "::before").content))).toEqual(['counter(sentence-line)', 'counter(sentence-line)']);
  const number = panel(page).getByRole("button", { name: "조건 1 최근 기간", exact: true });
  await expect(number).toHaveCSS("color", "rgb(199, 243, 107)");
  expect(await number.evaluate((node) => getComputedStyle(node).borderBottomStyle)).toBe("none");

  await screenAction(sentenceEditor(page), "지우기");
  const confirm = page.getByRole("dialog", { name: `"${SCREEN.name}" 조건식을 삭제할까요? 되돌릴 수 없습니다.` });
  await expect(confirm.getByRole("button", { name: "확인", exact: true })).toHaveCount(0);
  await expect(confirm.getByRole("button", { name: "취소", exact: true })).toBeFocused();
  await confirm.getByRole("button", { name: "조건식 지우기", exact: true }).click();
  await pollSaved(() => scenario.documents.screens().screens).toEqual([]);
});

test("고른 드로잉의 작은 막대는 설정·복제·잠금·지우기 순서다", async ({ page }) => {
  await open(page);
  await (await expandDock(page)).getByRole("button", { name: "추세선", exact: true }).click();
  const box = (await cell(page).boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.3, box.y + box.height * 0.6);
  await page.mouse.click(box.x + box.width * 0.6, box.y + box.height * 0.4);
  const bar = page.getByRole("toolbar", { name: "드로잉 스타일" });
  await expect(bar).toBeVisible();
  const order = await bar.getByRole("button").evaluateAll((buttons) => buttons.map((b) => b.getAttribute("aria-label")).filter((name) => ["드로잉 세부 설정", "드로잉 복제", "잠금", "드로잉 지우기"].includes(name ?? "")));
  expect(order).toEqual(["드로잉 세부 설정", "드로잉 복제", "잠금", "드로잉 지우기"]);
});
