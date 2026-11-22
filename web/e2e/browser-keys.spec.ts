import type { Locator, Page } from "@playwright/test";
import type { PublicSession } from "./fixtures/public-mode-data";
import { expect, test } from "./harness";

const SESSION: PublicSession = { provider: "google", createdAt: Date.parse("2026-11-09T09:30:00+09:00") / 1000 };
const PASSWORD = "vault-pass-phrase-1";
const FIRST = { alias: "첫째 키", appKey: "AKFIRST-1111-aaaa-bbbb-cccc", appSecret: "SKFIRST-secret-value-0001" };
const SECOND = { alias: "둘째 키", appKey: "AKSECOND-2222-dddd-eeee-ffff", appSecret: "SKSECOND-secret-value-0002" };
const SECRETS = [FIRST.appKey, FIRST.appSecret, SECOND.appKey, SECOND.appSecret, PASSWORD];

const settings = (page: Page) => page.getByRole("dialog", { name: "시스템 설정", exact: true });
const keys = (page: Page) => settings(page).getByTestId("browser-keys");
const rows = (page: Page) => keys(page).getByTestId("browser-key-row");
const unlockForm = (page: Page) => keys(page).getByRole("form", { name: "잠금 풀기" });
const addForm = (page: Page) => keys(page).getByRole("form", { name: "키 더하기" });
const password = (scope: Locator, name: string) => scope.locator(`input[name="${name}"]`);

async function openKeys(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "시스템 설정", exact: true }).click();
  await expect(keys(page)).toBeVisible();
}

async function reopenKeys(page: Page) {
  await page.reload();
  await page.getByRole("button", { name: "시스템 설정", exact: true }).click();
  await expect(keys(page)).toBeVisible();
}

async function addKey(page: Page, entry: typeof FIRST) {
  if (!(await addForm(page).isVisible())) await keys(page).getByRole("button", { name: "＋ 키 더하기" }).click();
  await addForm(page).getByLabel("별칭").fill(entry.alias);
  await addForm(page).getByLabel("앱키").fill(entry.appKey);
  await addForm(page).getByLabel("시크릿").fill(entry.appSecret);
  await addForm(page).getByRole("button", { name: "저장", exact: true }).click();
  await expect(rows(page).filter({ hasText: entry.alias })).toHaveCount(1);
}

const listOf = (page: Page) => rows(page).evaluateAll((items) => items.map((item) => item.textContent));

async function enablePassword(page: Page) {
  await keys(page).getByRole("button", { name: "잠금 비밀번호 켜기" }).click();
  const form = keys(page).getByRole("form", { name: "잠금 비밀번호 켜기" });
  await password(form, "vault-new-password").fill(PASSWORD);
  await password(form, "vault-new-password-again").fill(PASSWORD);
  await form.getByRole("button", { name: "켜기" }).click();
  await expect(keys(page).getByRole("button", { name: "잠금 비밀번호 끄기" })).toBeVisible();
}

async function unlock(page: Page, attempt: string) {
  await password(unlockForm(page), "vault-unlock-password").fill(attempt);
  await unlockForm(page).getByRole("button", { name: "풀기" }).click();
}

function watchLeaks(page: Page) {
  const seen: string[] = [];
  page.on("request", (request) => { seen.push(`${request.method()} ${request.url()} ${request.postData() ?? ""}`); });
  page.on("console", (message) => { seen.push(`console ${message.text()}`); });
  return {
    async expectNone() {
      const storage = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage }, url: location.href }));
      const cookies = JSON.stringify(await page.context().cookies());
      for (const secret of SECRETS) {
        expect(seen.filter((line) => line.includes(secret))).toEqual([]);
        expect(storage).not.toContain(secret);
        expect(cookies).not.toContain(secret);
      }
    },
  };
}

const storedRecord = (page: Page, name: string) =>
  page.evaluate(
    (record) => new Promise<{ present: boolean; extractable: boolean | null }>((resolve, reject) => {
      const open = indexedDB.open("vally-key-vault");
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const get = open.result.transaction("records").objectStore("records").get(record);
        get.onsuccess = () => { open.result.close(); resolve({ present: get.result !== undefined, extractable: get.result?.extractable ?? null }); };
      };
    }),
    name,
  );

test.beforeEach(({ scenario }) => scenario.publicMode.enable(SESSION));

test("처음에는 비밀번호를 묻지 않고 바로 키를 더한다", async ({ page }) => {
  await openKeys(page);
  await expect(keys(page)).toContainText("이번 단계는 키를 저장만 합니다. 키를 쓰는 기능은 다음 단계에 나옵니다");
  await expect(keys(page)).toContainText("공개 주소가 바뀌면 키를 다시 넣어야 합니다");
  await expect(unlockForm(page)).toHaveCount(0);
  await expect(addForm(page)).toBeVisible();
  await expect(keys(page)).not.toContainText("자동 잠금");
});

test("키 둘 더하기, 시세 키 바꾸기, 새로 고침 뒤 입력 없이 목록이 같다", async ({ page }) => {
  const leaks = watchLeaks(page);
  await openKeys(page);
  await addKey(page, FIRST);
  await addKey(page, SECOND);
  await expect(rows(page).filter({ hasText: "시세" })).toHaveCount(1);
  await expect(rows(page).first()).toContainText("시세");
  await keys(page).getByLabel("시세 키").selectOption("k2");
  await expect(rows(page).nth(1)).toContainText("시세");
  await expect(rows(page).first()).not.toContainText("시세");
  const before = await listOf(page);
  expect(before.join("")).not.toContain(FIRST.appKey);
  expect(before[0]).toContain("cccc");

  await reopenKeys(page);
  await expect(unlockForm(page)).toHaveCount(0);
  await expect(rows(page)).toHaveCount(2);
  expect(await listOf(page)).toEqual(before);
  expect(await storedRecord(page, "auto-key")).toEqual({ present: true, extractable: false });
  await leaks.expectNone();
});

test("같은 앱키와 여섯째 키는 오류 문구로 거절한다", async ({ page }) => {
  await openKeys(page);
  await addKey(page, FIRST);
  await keys(page).getByRole("button", { name: "＋ 키 더하기" }).click();
  await addForm(page).getByLabel("앱키").fill(FIRST.appKey);
  await addForm(page).getByLabel("시크릿").fill("다른 시크릿");
  await addForm(page).getByRole("button", { name: "저장", exact: true }).click();
  await expect(addForm(page).getByRole("alert")).toHaveText("이미 저장한 앱키입니다");
  await expect(rows(page)).toHaveCount(1);
});

test("비밀번호 켜기, 새로 고침, 잠김, 풀기, 끄기, 새로 고침 뒤 입력 없이 목록이 같다", async ({ page }) => {
  const leaks = watchLeaks(page);
  await openKeys(page);
  await addKey(page, FIRST);
  await addKey(page, SECOND);
  const before = await listOf(page);

  await enablePassword(page);
  expect(await storedRecord(page, "auto-key")).toEqual({ present: false, extractable: null });
  await reopenKeys(page);
  await expect(unlockForm(page)).toBeVisible();
  await expect(addForm(page)).toHaveCount(0);
  await expect(keys(page).getByRole("button", { name: "＋ 키 더하기" })).toHaveCount(0);

  await unlock(page, "wrong-password-1");
  await expect(unlockForm(page).getByRole("alert")).toHaveText("비밀번호가 맞지 않습니다");
  await unlock(page, PASSWORD);
  await expect(unlockForm(page)).toHaveCount(0);
  expect(await listOf(page)).toEqual(before);

  await keys(page).getByRole("button", { name: "잠그기" }).click();
  await expect(unlockForm(page)).toBeVisible();
  await unlock(page, PASSWORD);
  await expect(unlockForm(page)).toHaveCount(0);

  await keys(page).getByRole("button", { name: "잠금 비밀번호 끄기" }).click();
  const off = keys(page).getByRole("form", { name: "잠금 비밀번호 끄기" });
  await password(off, "vault-disable-password").fill("wrong-password-1");
  await off.getByRole("button", { name: "끄기" }).click();
  await expect(keys(page).getByRole("region", { name: "잠금 비밀번호" }).getByRole("alert")).toHaveText("비밀번호가 맞지 않습니다");
  await password(off, "vault-disable-password").fill(PASSWORD);
  await off.getByRole("button", { name: "끄기" }).click();
  await expect(keys(page).getByRole("button", { name: "잠금 비밀번호 켜기" })).toBeVisible();

  await reopenKeys(page);
  await expect(unlockForm(page)).toHaveCount(0);
  expect(await listOf(page)).toEqual(before);
  expect(await storedRecord(page, "auto-key")).toEqual({ present: true, extractable: false });
  await leaks.expectNone();
});

test("비밀번호는 8자 이상이고 두 번 같게 적어야 켠다", async ({ page }) => {
  await openKeys(page);
  await keys(page).getByRole("button", { name: "잠금 비밀번호 켜기" }).click();
  const form = keys(page).getByRole("form", { name: "잠금 비밀번호 켜기" });
  await password(form, "vault-new-password").fill("short");
  await password(form, "vault-new-password-again").fill("short");
  await expect(form.getByRole("button", { name: "켜기" })).toBeDisabled();
  await password(form, "vault-new-password").fill(PASSWORD);
  await password(form, "vault-new-password-again").fill(`${PASSWORD}-x`);
  await expect(form.getByRole("button", { name: "켜기" })).toBeDisabled();
  await password(form, "vault-new-password-again").fill(PASSWORD);
  await expect(form.getByRole("button", { name: "켜기" })).toBeEnabled();
});

test("모든 키 지우기 뒤에는 처음 상태로 돌아간다", async ({ page }) => {
  await openKeys(page);
  await addKey(page, FIRST);
  await enablePassword(page);
  await keys(page).getByRole("button", { name: "모든 키 지우기" }).click();
  await page.getByRole("dialog").filter({ hasText: "이 브라우저에 저장한 키를 모두 지웁니다" }).getByRole("button", { name: "모든 키 지우기" }).click();
  await expect(rows(page)).toHaveCount(0);
  await expect(addForm(page)).toBeVisible();
  await expect(keys(page).getByRole("button", { name: "잠금 비밀번호 켜기" })).toBeVisible();
  await reopenKeys(page);
  await expect(rows(page)).toHaveCount(0);
  await expect(unlockForm(page)).toHaveCount(0);
  expect(await storedRecord(page, "key:k1")).toEqual({ present: false, extractable: null });
});

test("계정 삭제에서 이 브라우저의 키도 지우기를 고르면 보관소를 지운다", async ({ page }) => {
  await openKeys(page);
  await addKey(page, FIRST);
  await settings(page).getByRole("tab", { name: "계정", exact: true }).click();
  await settings(page).getByRole("button", { name: "계정 삭제", exact: true }).click();
  const confirm = settings(page).getByRole("region", { name: "계정 삭제" });
  await confirm.getByRole("textbox").fill("계정 삭제");
  await confirm.getByLabel("이 브라우저의 키도 지우기").check();
  await confirm.getByRole("button", { name: "계정 삭제 실행" }).click();
  await expect(page.getByTestId("landing")).toBeVisible();
  expect(await storedRecord(page, "key:k1")).toEqual({ present: false, extractable: null });
});

test("계정 삭제에서 키도 지우기를 고르지 않으면 키가 남는다", async ({ page }) => {
  await openKeys(page);
  await addKey(page, FIRST);
  await settings(page).getByRole("tab", { name: "계정", exact: true }).click();
  await settings(page).getByRole("button", { name: "계정 삭제", exact: true }).click();
  const confirm = settings(page).getByRole("region", { name: "계정 삭제" });
  await confirm.getByRole("textbox").fill("계정 삭제");
  await confirm.getByRole("button", { name: "계정 삭제 실행" }).click();
  await expect(page.getByTestId("landing")).toBeVisible();
  expect((await storedRecord(page, "key:k1")).present).toBe(true);
});
