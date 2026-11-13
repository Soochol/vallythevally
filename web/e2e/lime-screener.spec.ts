import { fillNumber, renameScreen, expandEditor, savedEditor, addCondition, toggleExclude } from "./sentence-editor";
import { expect, test } from "./screener-harness";

test.use({ clockStart: "20261109100030" });

test("오른쪽 스크리너 탭에서 실제 조건식 편집창을 열어 조건·시장·제외를 저장하고 다시 편집한다", async ({ scenario, page }, info) => {
  await page.goto("/");
  await page.getByRole("tablist", { name: "오른쪽 패널" }).getByRole("tab", { name: /^스크리너/ }).click();
  await page.getByRole("complementary", { name: "스크리너", exact: true }).getByRole("button", { name: "새 조건식", exact: true }).click();
  const dialog = page.getByRole("region", { name: "조건식 편집", exact: true });
  await renameScreen(dialog, "라임 UI 조건식");
  await dialog.getByRole("group", { name: "대상 시장", exact: true }).getByRole("button", { name: "코스피", exact: true }).click();
  await toggleExclude(dialog, "종류", "ETF");
  await addCondition(dialog);
  await fillNumber(dialog.getByRole("button", { name: "조건 1 신고가 기간", exact: true }), "60");
  await page.screenshot({ path: info.outputPath("screener-editor.png"), fullPage: true });
  await dialog.getByRole("button", { name: "저장", exact: true }).click();
  await savedEditor(dialog);
  await expect.poll(async () => scenario.documents.screens().screens[0]).toMatchObject({ name: "라임 UI 조건식", markets: ["kospi"], exclude: ["etf"], conditions: [{ kind: "new_high", n: 60 }] });
  await expandEditor(page);
  const editing = page.getByRole("region", { name: "조건식 편집", exact: true });
  await expect(editing.getByRole("button", { name: "조건 1 신고가 기간", exact: true })).toHaveText("60");
  await renameScreen(editing, "로컬 수정");
  const remote = scenario.documents.screens();
  remote.screens[0].name = "다른 창에서 수정";
  scenario.documents.saveScreens({ ...remote, revision: remote.revision + 1 });
  await editing.getByRole("button", { name: "저장", exact: true }).click();
  await expect(editing.getByRole("alert")).toContainText("다른 탭이나 기기에서 조건식 목록이 바뀌어 덮어쓰지 않았습니다");
  expect(scenario.documents.screens().screens[0].name).toBe("다른 창에서 수정");
  await expect(editing.getByRole("button", { name: "조건식 고르기", exact: true })).toHaveText("로컬 수정");
  let rejected = false;
  await page.route("**/api/screens", async (route) => {
    if (route.request().method() === "PUT" && !rejected) {
      rejected = true;
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ code: "unavailable", message: "시험용 저장 실패" }) });
    } else await route.fallback();
  });
  await editing.getByRole("button", { name: "저장", exact: true }).click();
  await expect(editing.getByRole("alert")).toContainText("저장하지 못했습니다");
  await expect(editing.getByRole("button", { name: "조건식 메뉴", exact: true })).toBeEnabled();
  await expect(editing.getByRole("button", { name: "조건식 고르기", exact: true })).toHaveText("로컬 수정");
  await editing.getByRole("button", { name: "저장", exact: true }).click();
  await savedEditor(editing);
  expect(scenario.documents.screens().screens[0]).toMatchObject({ name: "로컬 수정", markets: ["kospi"], exclude: ["etf"], conditions: [{ kind: "new_high", n: 60 }] });
});
