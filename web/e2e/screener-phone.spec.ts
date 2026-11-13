import type { Locator, Page } from "@playwright/test";
import type { Screen } from "../src/api/generated/Screen";
import type { Screens } from "../src/api/generated/Screens";
import { type App, expect, test } from "./harness";
import { openScreener, panel, savedTo } from "./screener-page";
import { renameScreen, sentenceEditor } from "./sentence-editor";

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1440, height: 900 };
const STALE = "다른 탭이나 기기에서 조건식 목록이 바뀌어 덮어쓰지 않았습니다. 변경 내용은 유지했습니다. 다시 저장하면 최신 목록에 반영합니다.";

test.use({ viewport: PHONE });

const screenOf = (id: string, name: string): Screen => ({ id, name, markets: [], exclude: [], conditions: [] });
const stored = async (app: App): Promise<Screens> => (await fetch(`${app.url}/api/screens`)).json();
const dialogOf = (page: Page, title: string) => page.getByRole("dialog", { name: title, exact: true });
const nameField = (dialog: Locator) => dialog.getByRole("textbox", { name: "이름", exact: true });
const chooser = (page: Page) => panel(page).getByRole("button", { name: /^조건식: / });
const unsaved = (page: Page) => panel(page).getByText("저장 안 됨", { exact: true });

async function store(app: App, screens: Screen[]) {
  const { revision } = await stored(app);
  const response = await fetch(`${app.url}/api/screens`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ screens, revision: revision + 1 }) });
  expect(response.ok).toBe(true);
}

async function openPhone(page: Page) {
  await page.getByRole("navigation", { name: "휴대폰 탭" }).getByRole("button", { name: "스크리너" }).click();
  await expect(chooser(page).or(panel(page).getByText("저장한 조건식이 없습니다"))).toBeVisible();
}

async function startPhone(app: App, page: Page, screens: Screen[]) {
  await store(app, screens);
  await page.goto("/");
  await openPhone(page);
}

async function editChosen(page: Page, title = "조건식 편집") {
  await panel(page).getByRole("button", { name: "편집", exact: true }).click();
  const dialog = dialogOf(page, title);
  await expect(dialog).toBeVisible();
  return dialog;
}

async function createScreen(page: Page) {
  await panel(page).getByRole("button", { name: "새 조건식", exact: true }).click();
  const dialog = dialogOf(page, "새 조건식");
  await expect(dialog).toBeVisible();
  return dialog;
}

async function closeDialog(dialog: Locator) {
  await dialog.getByRole("button", { name: "닫기", exact: true }).click();
  await expect(dialog).toBeHidden();
}

async function pickerItems(page: Page) {
  await chooser(page).click();
  const items = page.getByRole("menu", { name: "조건식 고르기", exact: true }).getByRole("menuitemradio");
  const texts = await items.evaluateAll((all) => all.map((item) => [...item.querySelectorAll("span")].map((span) => span.textContent ?? "").filter(Boolean).join(" | ")));
  await page.keyboard.press("Escape");
  return texts;
}

function countPuts(page: Page) {
  const puts: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "PUT" && new URL(request.url()).pathname === "/api/screens") puts.push(request.url());
  });
  return puts;
}

test("휴대폰에서 고친 것이 있을 때만 저장하고, 저장하면 그 조건식을 고른 채 대화상자를 닫는다", async ({ app, page }) => {
  await startPhone(app, page, [screenOf("a", "기존 식")]);
  const editing = await editChosen(page);
  await expect(editing.getByRole("button", { name: "저장", exact: true })).toBeDisabled();
  await closeDialog(editing);
  const dialog = await createScreen(page);
  await nameField(dialog).fill("휴대폰 식");
  await dialog.getByRole("group", { name: "시장" }).getByRole("button", { name: "코스피", exact: true }).click();
  const saved = savedTo(page, "/api/screens");
  await dialog.getByRole("button", { name: "저장", exact: true }).click();
  await saved;
  await expect(dialog).toBeHidden();
  await expect(chooser(page)).toHaveAccessibleName("조건식: 휴대폰 식");
  await expect(unsaved(page)).toHaveCount(0);
  expect((await stored(app)).screens).toMatchObject([{ id: "a", name: "기존 식" }, { name: "휴대폰 식", markets: ["kospi"], conditions: [] }]);
});

test("휴대폰에서 저장이 충돌하면 문구와 초안을 남기고, 다시 저장하면 다른 기기의 식을 지키며 덮어쓴다", async ({ app, page }) => {
  await startPhone(app, page, [screenOf("a", "기존 식")]);
  const dialog = await editChosen(page);
  await nameField(dialog).fill("휴대폰 수정");
  await store(app, [screenOf("a", "다른 기기 수정"), screenOf("b", "다른 기기 식")]);
  await dialog.getByRole("button", { name: "저장", exact: true }).click();
  await expect(dialog.getByRole("alert")).toHaveText(STALE);
  await expect(nameField(dialog)).toHaveValue("휴대폰 수정");
  expect((await stored(app)).screens.map((screen) => screen.name)).toEqual(["다른 기기 수정", "다른 기기 식"]);
  const saved = savedTo(page, "/api/screens");
  await dialog.getByRole("button", { name: "저장", exact: true }).click();
  await saved;
  await expect(dialog).toBeHidden();
  await expect(chooser(page)).toHaveAccessibleName("조건식: 휴대폰 수정");
  expect((await stored(app)).screens.map((screen) => [screen.id, screen.name])).toEqual([["a", "휴대폰 수정"], ["b", "다른 기기 식"]]);
});

test("휴대폰에서 50개가 찬 목록의 새 조건식은 저장을 시도한 뒤 오류를 보이고 보내지 않으며, 닫아도 저장 안 됨으로 남는다", async ({ app, page }) => {
  await startPhone(app, page, Array.from({ length: 50 }, (_, index) => screenOf(`s${index}`, `식 ${index + 1}`)));
  const puts = countPuts(page);
  const dialog = await createScreen(page);
  await nameField(dialog).fill("51번째");
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await dialog.getByRole("button", { name: "저장", exact: true }).click();
  await expect(dialog.getByRole("alert")).toHaveText("조건식은 50개까지 저장할 수 있습니다. 하나를 지운 뒤 만드세요.");
  await expect(dialog).toBeVisible();
  await closeDialog(dialog);
  await expect(chooser(page)).toHaveAccessibleName("조건식: 51번째");
  await expect(unsaved(page)).toBeVisible();
  const items = await pickerItems(page);
  expect(items).toHaveLength(51);
  expect(items.at(-1)).toBe("51번째 | 저장 안 됨");
  expect(items.filter((item) => item.includes("저장 안 됨"))).toHaveLength(1);
  const reopened = await editChosen(page, "새 조건식");
  await expect(nameField(reopened)).toHaveValue("51번째");
  expect(puts).toEqual([]);
  expect((await stored(app)).screens).toHaveLength(50);
});

test("휴대폰에서 지우면 다음 조건식을 고르고 지운 식의 초안을 버리며, 저장하지 않은 초안은 요청 없이 지운다", async ({ app, page }) => {
  await startPhone(app, page, [screenOf("a", "첫째"), screenOf("b", "둘째")]);
  const dialog = await editChosen(page);
  await nameField(dialog).fill("지울 초안");
  await dialog.getByRole("button", { name: "삭제", exact: true }).click();
  const saved = savedTo(page, "/api/screens");
  await page.getByRole("dialog", { name: '"지울 초안" 조건식을 삭제할까요? 되돌릴 수 없습니다.' }).getByRole("button", { name: "확인", exact: true }).click();
  await saved;
  await expect(dialog).toBeHidden();
  await expect(chooser(page)).toHaveAccessibleName("조건식: 둘째");
  expect(await pickerItems(page)).toEqual(["둘째"]);
  expect((await stored(app)).screens.map((screen) => screen.id)).toEqual(["b"]);

  const puts = countPuts(page);
  const draft = await createScreen(page);
  await nameField(draft).fill("임시");
  await closeDialog(draft);
  await expect(chooser(page)).toHaveAccessibleName("조건식: 임시");
  const reopened = await editChosen(page, "새 조건식");
  await reopened.getByRole("button", { name: "삭제", exact: true }).click();
  await page.getByRole("dialog", { name: '"임시" 조건식을 삭제할까요? 되돌릴 수 없습니다.' }).getByRole("button", { name: "확인", exact: true }).click();
  await expect(reopened).toBeHidden();
  await expect(chooser(page)).toHaveAccessibleName("조건식: 둘째");
  expect(await pickerItems(page)).toEqual(["둘째"]);
  expect(puts).toEqual([]);
});

test("조건식 초안은 휴대폰과 데스크톱 폭을 넘나들어도 남는다", async ({ app, page }) => {
  await startPhone(app, page, [screenOf("a", "첫째")]);
  const dialog = await editChosen(page);
  await nameField(dialog).fill("휴대폰 초안");
  await closeDialog(dialog);
  await expect(chooser(page)).toHaveAccessibleName("조건식: 휴대폰 초안");
  await expect(unsaved(page)).toBeVisible();

  await page.setViewportSize(DESKTOP);
  await openScreener(page);
  const editor = sentenceEditor(page);
  await expect(editor.getByRole("button", { name: "조건식 고르기", exact: true })).toHaveText("휴대폰 초안");
  await expect(editor.getByText("변경됨", { exact: true })).toBeVisible();
  await renameScreen(editor, "데스크톱 초안");

  await page.setViewportSize(PHONE);
  await openPhone(page);
  await expect(chooser(page)).toHaveAccessibleName("조건식: 데스크톱 초안");
  await expect(unsaved(page)).toBeVisible();
  expect(await pickerItems(page)).toEqual(["데스크톱 초안 | 저장 안 됨"]);
  const reopened = await editChosen(page);
  await expect(nameField(reopened)).toHaveValue("데스크톱 초안");
  expect((await stored(app)).screens.map((screen) => screen.name)).toEqual(["첫째"]);
});
