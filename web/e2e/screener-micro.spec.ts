import { resultRows } from "./fixtures/screener";
import { addCondition, expandEditor, expectSentences, fillNumber, renameScreen, savedEditor } from "./sentence-editor";
import { expect, test } from "./screener-harness";
import { editor, expectRows, openScreener, panel, results, runButton, savedTo, updateBand, waitForUpdateToFinish } from "./screener-page";
import type { Screen } from "../src/api/generated/Screen";

const SCREEN_NAME = "프로그램 순매수 신고가";
const PROGRAM_LINE = "프로그램 순매수 최근 5일 1000백만 원 이상이다";
const HIGH_LINE = "신고가 일봉 최근 1일 이내에 고가가 60일 최고인 봉이 있다";

test("프로그램 순매수와 신고가 조건식을 만들고 실행해 결과와 프로그램 열을 확인한 뒤 새로고침해도 조건이 유지된다", async ({ scenario, screener, page }) => {
  const runBodies: Screen[] = [];
  scenario.on("/api/screener/run", (request) => {
    const raw = request.postData();
    if (raw) runBodies.push(JSON.parse(raw) as Screen);
    const base = resultRows([["120010", "가상교차급증", "11-06"]], { universe: 16, excluded: { listedTooShort: 0, historyShort: 0, unconfirmed: 0 } });
    return {
      body: {
        ...base,
        rows: base.rows.map((row) => ({ ...row, programNetMillionWon: 1700 })),
      },
    };
  });

  await page.goto("/");
  await openScreener(page);
  await updateBand(page).getByRole("button", { name: "처음 받기" }).click();
  await waitForUpdateToFinish(page, "11-06(금)");

  await panel(page).getByRole("button", { name: "새 조건식" }).click();
  const dialog = editor(page, "새 조건식");
  await renameScreen(dialog, SCREEN_NAME);
  await addCondition(dialog, "프로그램 순매수");
  await addCondition(dialog, "신고가");
  await fillNumber(dialog.getByRole("button", { name: "조건 2 신고가 기간", exact: true }), "60");
  await expectSentences(dialog, [PROGRAM_LINE, HIGH_LINE]);

  const saved = savedTo(page, "/api/screens");
  await dialog.getByRole("button", { name: "저장" }).click();
  await saved;
  await savedEditor(dialog);

  expect(scenario.documents.screens().screens).toEqual([
    {
      id: expect.any(String),
      name: SCREEN_NAME,
      markets: [],
      exclude: [],
      conditions: [
        { kind: "program_net_buy", days: 5, minMillionWon: 1000, maxMillionWon: null },
        { kind: "new_high", period: "D", recentBars: 1, field: "high", n: 60 },
      ],
    },
  ]);

  await runButton(page).click();
  await expect(results(page)).toContainText("1종목 · 11-06(금) 기준");
  await expectRows(page, [["120010", "가상교차급증"]]);
  await expect(results(page).getByRole("columnheader", { name: "프로그램" })).toBeVisible();
  await expect(results(page).locator('tr[data-code="120010"]')).toContainText("+1,700백만");
  expect(runBodies).toHaveLength(1);
  expect(runBodies[0]?.conditions).toEqual([
    { kind: "program_net_buy", days: 5, minMillionWon: 1000, maxMillionWon: null },
    { kind: "new_high", period: "D", recentBars: 1, field: "high", n: 60 },
  ]);

  screener.showStatus({
    lastDay: "2026-11-06",
    needDay: "2026-11-06",
    todayAvailable: false,
    fullHistory: { done: 16, total: 16 },
    unconfirmed: 0,
    update: null,
  });
  await page.reload();
  await openScreener(page);
  await expect(panel(page).getByRole("button", { name: "조건식 고르기", exact: true })).toHaveText(SCREEN_NAME);
  await expandEditor(page);
  await expectSentences(editor(page, "조건식 편집"), [PROGRAM_LINE, HIGH_LINE]);
});
