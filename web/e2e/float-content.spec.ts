import type { Page } from "@playwright/test";
import { type App, cell, expect, SEARCH_BUTTON_TITLE, test } from "./harness";
import { openScreener, panel } from "./screener-page";
import { expandEditor, screenAction, sentenceEditor } from "./sentence-editor";

test.use({ clockStart: "20261109100030", viewport: { width: 1440, height: 900 } });

const toolbar = (page: Page) => page.getByRole("toolbar", { name: "차트 도구 막대" });
const SCREEN = { id: "seeded", name: "고가 60일 신고가", markets: ["kospi"], exclude: ["etf"], conditions: [{ kind: "new_high", period: "D", recentBars: 20, field: "high", n: 60 }, { kind: "market_cap", min: 300_000_000_000, max: null }] };

async function open(page: Page) {
  await page.goto("/?symbol=005930");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
}

async function seedScreen(app: App) {
  expect((await fetch(`${app.url}/api/screens`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ screens: [SCREEN], revision: 1 }) })).status).toBe(200);
}

test("위 막대는 종목 버튼과 검색 아이콘으로 같은 검색 창을 열고 툴팁은 이름과 단축키를 나눠 보인다", async ({ page }) => {
  await open(page);
  const symbol = toolbar(page).getByRole("button", { name: /삼성전자/ });
  await expect(symbol).toContainText("005930");
  await symbol.click();
  await expect(page.getByRole("dialog", { name: "종목 검색", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByTitle(SEARCH_BUTTON_TITLE).click();
  await expect(page.getByRole("dialog", { name: "종목 검색", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  expect(await toolbar(page).evaluate((node) => node.scrollWidth - node.clientWidth)).toBe(0);

  await toolbar(page).getByRole("button", { name: "지표", exact: true }).hover();
  const tip = page.getByRole("tooltip");
  await expect(tip).toHaveText("지표I");
  await expect(tip.locator("kbd")).toHaveText("I");
});

test("재무자료 표시는 상태 점과 함께 배경 없는 상태 창을 열고 자세히에서 전체 현황을 편다", async ({ page }) => {
  await open(page);
  const button = toolbar(page).getByRole("button", { name: "재무자료", exact: true });
  await button.click();
  const status = page.getByRole("dialog", { name: "재무자료", exact: true });
  await expect(status.getByRole("status")).toBeVisible();
  await expect(page.locator(".ui-dialog-backdrop")).toHaveCount(0);
  const box = (await status.boundingBox())!;
  const anchor = (await button.boundingBox())!;
  expect(box.y).toBeGreaterThanOrEqual(anchor.y + anchor.height);
  await expect(status.getByText("현재 단계", { exact: true })).toBeHidden();
  await status.getByRole("button", { name: "자세히", exact: true }).click();
  await expect(status.getByText("현재 단계", { exact: true })).toBeVisible();
  await status.getByRole("button", { name: "간단히", exact: true }).click();
  await expect(status.getByText("현재 단계", { exact: true })).toBeHidden();
  await status.getByRole("button", { name: "닫기", exact: true }).first().click();
  await expect(status).toHaveCount(0);
  await expect(button).toBeFocused();
});

test("조건 문장은 번호 배지와 알약 낱말로 보이고 지우기 확인 창은 무엇을 지우는지 버튼에 적는다", async ({ app, page }) => {
  await seedScreen(app);
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
  await expect.poll(async () => (await (await fetch(`${app.url}/api/screens`)).json()).screens).toEqual([]);
});

test("고른 드로잉의 작은 막대는 설정·복제·잠금·지우기 순서다", async ({ page }) => {
  await open(page);
  await page.getByRole("navigation", { name: "드로잉 도구" }).getByRole("button", { name: "추세선", exact: true }).click();
  const box = (await cell(page).boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.3, box.y + box.height * 0.6);
  await page.mouse.click(box.x + box.width * 0.6, box.y + box.height * 0.4);
  const bar = page.getByRole("toolbar", { name: "드로잉 스타일" });
  await expect(bar).toBeVisible();
  const order = await bar.getByRole("button").evaluateAll((buttons) => buttons.map((b) => b.getAttribute("aria-label")).filter((name) => ["드로잉 세부 설정", "드로잉 복제", "잠금", "드로잉 지우기"].includes(name ?? "")));
  expect(order).toEqual(["드로잉 세부 설정", "드로잉 복제", "잠금", "드로잉 지우기"]);
});
