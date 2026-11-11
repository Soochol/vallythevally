import { expect, test } from "./harness";

test.use({ clockStart: "20261109100030" });

test("스크리너 전체 화면에서 실제 조건식 편집창을 열어 조건·시장·제외를 저장하고 다시 편집한다", async ({ app, page }, info) => {
  await page.goto("/");
  await page.getByRole("navigation", { name: "주 메뉴" }).getByRole("button", { name: "스크리너", exact: true }).click();
  await page.getByRole("navigation", { name: "내 조건식", exact: true }).getByRole("button", { name: "새 조건식", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "새 조건식", exact: true });
  await dialog.getByLabel("이름", { exact: true }).fill("라임 UI 조건식");
  await dialog.getByRole("group", { name: "시장", exact: true }).getByRole("button", { name: "코스피", exact: true }).click();
  await dialog.getByRole("group", { name: "종류 제외", exact: true }).getByRole("button", { name: "ETF", exact: true }).click();
  await dialog.getByRole("button", { name: "조건 더하기", exact: true }).click();
  await dialog.getByRole("textbox", { name: "조건 1 신고가 기간", exact: true }).fill("60");
  await page.screenshot({ path: info.outputPath("screener-editor.png"), fullPage: true });
  await dialog.getByRole("button", { name: "저장", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(async () => (await (await fetch(`${app.url}/api/screens`)).json()).screens[0]).toMatchObject({ name: "라임 UI 조건식", markets: ["kospi"], exclude: ["etf"], conditions: [{ kind: "new_high", n: 60 }] });
  await page.getByRole("complementary", { name: "스크리너", exact: true }).getByRole("button", { name: "편집", exact: true }).click();
  const editing = page.getByRole("dialog", { name: "조건식 편집", exact: true });
  await expect(editing.getByRole("textbox", { name: "조건 1 신고가 기간", exact: true })).toHaveValue("60");
  await editing.getByLabel("이름", { exact: true }).fill("로컬 수정");
  const remote = await (await fetch(`${app.url}/api/screens`)).json();
  remote.screens[0].name = "다른 창에서 수정";
  expect((await fetch(`${app.url}/api/screens`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...remote, revision: remote.revision + 1 }) })).ok).toBe(true);
  await editing.getByRole("button", { name: "저장", exact: true }).click();
  await expect(editing.getByRole("alert")).toContainText("다른 탭이나 기기에서 조건식 목록이 바뀌어 덮어쓰지 않았습니다");
  expect((await (await fetch(`${app.url}/api/screens`)).json()).screens[0].name).toBe("다른 창에서 수정");
  await expect(editing.getByLabel("이름", { exact: true })).toHaveValue("로컬 수정");
  let rejected = false;
  await page.route("**/api/screens", async (route) => {
    if (route.request().method() === "PUT" && !rejected) {
      rejected = true;
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ code: "unavailable", message: "시험용 저장 실패" }) });
    } else await route.continue();
  });
  await editing.getByRole("button", { name: "저장", exact: true }).click();
  await expect(editing.getByRole("alert")).toContainText("저장하지 못했습니다");
  await expect(editing.getByLabel("이름", { exact: true })).toBeEnabled();
  await expect(editing.getByLabel("이름", { exact: true })).toHaveValue("로컬 수정");
  await editing.getByRole("button", { name: "저장", exact: true }).click();
  await expect(editing).toHaveCount(0);
  expect((await (await fetch(`${app.url}/api/screens`)).json()).screens[0]).toMatchObject({ name: "로컬 수정", markets: ["kospi"], exclude: ["etf"], conditions: [{ kind: "new_high", n: 60 }] });
});
