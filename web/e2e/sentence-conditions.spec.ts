import { selectOption } from "./select-option";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test } from "./harness";
import { addCondition, conditionAction, numberToken, renameScreen, savedEditor, sentenceEditor, setNumber } from "./sentence-editor";
import { openScreener, panel, runButton, updateBand, waitForUpdateToFinish } from "./screener-page";

test.use({ krxMarket: "20261106", clockStart: "20261106203000" });

test("문장형 숫자 팝오버를 적용한 미저장 조건식을 실행하고 줄을 끌어 재배열한다", async ({ page }) => {
  await page.goto("/");
  await openScreener(page);
  await updateBand(page).getByRole("button", { name: "처음 받기", exact: true }).click();
  await waitForUpdateToFinish(page, "11-06(금)");
  await panel(page).getByRole("button", { name: "새 조건식", exact: true }).click();
  const editor = sentenceEditor(page);
  await renameScreen(editor, "저장 전 문장 실행");
  await addCondition(editor, "신고가");
  await setNumber(editor, "조건 1 신고가 기간", "2");
  await addCondition(editor, "거래 급증");
  await setNumber(editor, "조건 2 배수", "1");
  const first = editor.getByRole("button", { name: "조건 1 순서 끌어서 바꾸기", exact: true });
  const second = editor.getByRole("button", { name: "조건 2 순서 끌어서 바꾸기", exact: true });
  await second.dragTo(first);
  await expect(numberToken(editor, "조건 1 배수")).toHaveText("1");
  await expect(numberToken(editor, "조건 2 신고가 기간")).toHaveText("2");
  const response = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/screener/run");
  await runButton(page).click();
  const run = await response;
  expect(run.ok()).toBe(true);
  expect(run.request().postDataJSON()).toMatchObject({ name: "저장 전 문장 실행", conditions: [
    { kind: "surge", times: 1 }, { kind: "new_high", n: 2 },
  ] });
  expect((await (await page.request.get("/api/screens")).json()).screens).toEqual([]);
  await expect(editor.getByText("변경됨", { exact: true })).toBeVisible();
  await mkdir(resolve("../target/ux-screens"), { recursive: true });
  for (const size of [{ width: 1440, height: 900 }, { width: 1024, height: 768 }]) {
    await page.setViewportSize(size);
    await page.screenshot({ path: resolve(`../target/ux-screens/sentence-editor-${size.width}x${size.height}.png`) });
  }
  await conditionAction(editor, 1, "조건 지우기");
  await editor.getByRole("button", { name: "저장", exact: true }).click();
  await savedEditor(editor);
  const saved = (await (await page.request.get("/api/screens")).json()).screens;
  expect(saved).toHaveLength(1);
  expect(saved[0].conditions).toEqual([{ kind: "new_high", period: "D", recentBars: 1, field: "high", n: 2 }]);
});

test("모든 조건 종류의 문장 숫자 편집을 저장하고 마지막 줄까지 지운다", async ({ page }) => {
  await page.goto("/");
  await openScreener(page);
  await panel(page).getByRole("button", { name: "새 조건식", exact: true }).click();
  const editor = sentenceEditor(page);
  await renameScreen(editor, "문장별 설정");
  const variants = [
    ["신고가", "신고가 기간", "3", { kind: "new_high", field: "high", n: 3 }],
    ["신저가", "신저가 기간", "3", { kind: "new_low", n: 3 }],
    ["값 범위", "최소", "100", { kind: "value_range", field: "close", min: 100 }],
    ["등락률", "비교 봉 수", "2", { kind: "change", back: 2 }],
    ["고점·저점 거리", "기간", "53", { kind: "near_extreme", n: 53 }],
    ["신고거래량", "신고거래량 기간", "3", { kind: "new_high", field: "volume", n: 3 }],
    ["신고거래대금", "신고거래대금 기간", "3", { kind: "new_high", field: "traded_value", n: 3 }],
    ["거래 급증", "배수", "2", { kind: "surge", times: 2 }],
    ["이평 위치", "이평 기간", "7", { kind: "ma_position", length: 7 }],
    ["이평 배열", "이평 1", "6", { kind: "ma_alignment", lengths: [6, 20, 60, 120] }],
    ["이평 교차", "짧은 이평", "6", { kind: "ma_cross", fast: 6 }],
    ["RSI", "RSI 기간", "15", { kind: "rsi", length: 15 }],
    ["MACD", "시그널 기간", "10", { kind: "macd", signal: 10 }],
    ["스토캐스틱", "%K 기간", "6", { kind: "stochastic", k: 6 }],
    ["볼린저 밴드", "표준편차 배수", "3", { kind: "bollinger", k: 3 }],
    ["일목균형표", "전환선 기간", "10", { kind: "ichimoku", conversion: 10 }],
    ["시가총액", "최소", "1234", { kind: "market_cap", min: 123400000000 }],
  ] as const;
  for (const [label, field, value, expected] of variants) {
    await test.step(label, async () => {
      await addCondition(editor, label);
      if (expected.kind === "value_range") await selectOption(editor.getByRole("combobox", { name: "조건 1 값", exact: true }), "close");
      await setNumber(editor, `조건 1 ${field}`, value);
      await editor.getByRole("button", { name: "저장", exact: true }).click();
      await savedEditor(editor);
      const saved = (await (await page.request.get("/api/screens")).json()).screens[0];
      expect(saved.conditions).toHaveLength(1);
      expect(saved.conditions[0]).toMatchObject(expected);
      await conditionAction(editor, 1, "조건 지우기");
      await editor.getByRole("button", { name: "저장", exact: true }).click();
      await savedEditor(editor);
      expect((await (await page.request.get("/api/screens")).json()).screens[0].conditions).toEqual([]);
    });
  }
});

test("넓게 보기에서 접힌 잘못된 조건을 저장하면 펼쳐진 첫 오류 값에 포커스를 준다", async ({ page }) => {
  await page.goto("/");
  await openScreener(page);
  await panel(page).getByRole("button", { name: "새 조건식", exact: true }).click();
  const editor = sentenceEditor(page);
  await renameScreen(editor, "접힌 오류 값");
  await addCondition(editor);
  await setNumber(editor, "조건 1 최근 기간", "0");
  await page.getByRole("button", { name: "넓게 보기", exact: true }).click();
  await expect(editor.getByRole("button", { name: "조건 펼치기", exact: true })).toBeVisible();
  await editor.getByRole("button", { name: "저장", exact: true }).click();
  const invalid = numberToken(editor, "조건 1 최근 기간");
  await expect(invalid).toBeVisible();
  await expect(invalid).toHaveAttribute("aria-invalid", "true");
  await expect(invalid).toBeFocused();
  expect((await (await page.request.get("/api/screens")).json()).screens).toEqual([]);
});
