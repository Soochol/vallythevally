import { writeFile } from "node:fs/promises";
import type { Page } from "@playwright/test";
import { expect, test } from "./harness";

const panel = (page: Page) => page.getByRole("complementary", { name: "관심종목" });
const row = (page: Page, code: string) => panel(page).locator(`li[data-code="${code}"]`);
const listButton = (page: Page) => panel(page).getByRole("button", { name: /^관심종목 목록: / });
const serverLists = async (page: Page) => (await (await page.request.get("/api/watchlists")).json()).lists;
const rowCodes = (page: Page) => panel(page).locator("li[data-code]").evaluateAll((rows) => rows.map((r) => r.getAttribute("data-code")));
const readServer = async (page: Page) => (await (await page.request.get("/api/watchlists")).json());
const conflict = (page: Page) => page.getByRole("status").getByText("다른 곳에서 바뀌어 되돌리지 못했습니다", { exact: true });

async function prepare(page: Page) {
  expect((await page.request.put("/api/watchlists", { data: { revision: 100, lists: [
    { id: "source", name: "기본", symbols: ["005930", "086520", "005935"] },
    { id: "target", name: "대상", symbols: [] },
  ] } })).ok()).toBe(true);
  await page.goto("/?symbol=005930");
  await expect(row(page, "086520")).toContainText("에코프로");
  await row(page, "086520").click({ button: "right" });
  await page.getByRole("menuitem", { name: /^관심종목에서 빼기/ }).click();
  await expect.poll(async () => (await serverLists(page))[0].symbols).toEqual(["005930", "005935"]);
  await expect(page.getByRole("contentinfo")).toContainText("자동 저장됨");
}

async function holdReads(page: Page) {
  const state: { reads: number; puts: number; readRevisions: number[]; putRevisions: number[]; release(): void } = { reads: 0, puts: 0, readRevisions: [], putRevisions: [], release: () => {} };
  const gate = new Promise<void>((resolve) => { state.release = resolve; });
  await page.route("**/api/watchlists", async (route) => {
    if (route.request().method() !== "GET") {
      if (route.request().method() === "PUT") { state.puts++; state.putRevisions.push(route.request().postDataJSON().revision); }
      await route.continue();
      return;
    }
    const response = await route.fetch();
    state.readRevisions.push((await response.json()).revision);
    state.reads++;
    await gate;
    await route.fulfill({ response });
  });
  return state;
}

test("늦은 되돌리기 조회 뒤 다른 탭 복제를 보존하며 조건부 저장을 재시도한다", async ({ page, context }, info) => {
  await prepare(page);
  const other = await context.newPage();
  await other.goto("/?symbol=005930");
  await expect(listButton(other)).toBeVisible();
  const held = await holdReads(page);
  await page.getByRole("button", { name: "되돌리기", exact: true }).click();
  await expect.poll(() => held.reads).toBeGreaterThan(0);
  await expect(page.getByRole("button", { name: "되돌리기", exact: true })).toHaveCount(0);
  await listButton(other).click();
  await other.getByRole("menuitem", { name: "복제", exact: true }).click();
  await expect.poll(async () => (await serverLists(page)).length).toBe(3);
  const before = await serverLists(page);
  held.release();
  await expect.poll(async () => (await serverLists(page))[0].symbols).toEqual(["005930", "086520", "005935"]);
  const after = await serverLists(page);
  await writeFile(info.outputPath("slow-remote.json"), JSON.stringify({ reads: held.reads, puts: held.puts, before, after }, null, 2));
  expect(after, "A slow read must not erase the list saved while undo was waiting").toEqual([
    { ...before[0], symbols: ["005930", "086520", "005935"] }, ...before.slice(1),
  ]);
  expect(held.puts).toBe(2);
  expect(held.putRevisions).toEqual(held.readRevisions.map((r) => r + 1));
  await row(page, "005935").locator("[data-main]").press("Alt+ArrowUp");
  await expect.poll(async () => (await serverLists(page))[0].symbols).toEqual(["005930", "005935", "086520"]);
  expect((await serverLists(page)).slice(1)).toEqual(before.slice(1));
});

test("충돌 뒤 대상 목록이 지워지면 되돌리지 않고 최신 서버 자료를 보존한다", async ({ page, context }) => {
  await prepare(page);
  const other = await context.newPage();
  await other.goto("/");
  await expect(listButton(other)).toBeVisible();
  const held = await holdReads(page);
  await page.getByRole("button", { name: "되돌리기", exact: true }).click();
  await expect.poll(() => held.reads).toBeGreaterThan(0);
  await listButton(other).click();
  await other.getByRole("menuitem", { name: "목록 지우기", exact: true }).click();
  await other.getByRole("dialog").getByRole("button", { name: "목록 지우기", exact: true }).click();
  await expect.poll(async () => (await serverLists(page)).length).toBe(1);
  const before = await readServer(page);
  held.release();
  await expect(conflict(page)).toBeVisible();
  expect(await readServer(page)).toEqual(before);
  expect(held.puts).toBe(1);
});

test("되돌리기 조건부 PUT 500은 로컬과 서버를 덮지 않는다", async ({ page }) => {
  await prepare(page);
  const before = await readServer(page);
  let puts = 0;
  await page.route("**/api/watchlists", async (route) => {
    if (route.request().method() !== "PUT") return route.continue();
    puts++;
    await route.fulfill({ status: 500, json: { error: { code: "internal", message: "저장 실패" } } });
  });
  await page.getByRole("button", { name: "되돌리기", exact: true }).click();
  await expect(page.getByRole("status").getByText("관심종목을 확인하지 못해 되돌리지 않았습니다. 다시 불러와 주세요")).toBeVisible();
  expect(await readServer(page)).toEqual(before);
  expect(await rowCodes(page)).toEqual(["005930", "005935"]);
  expect(puts).toBe(1);
});

test("빼기와 조건부 저장이 모두 실패하면 옛 자동 재시도가 서버 자료를 바꾸지 않는다", async ({ page }) => {
  expect((await page.request.put("/api/watchlists", { data: { revision: 100, lists: [
    { id: "source", name: "기본", symbols: ["005930", "086520", "005935"] },
  ] } })).ok()).toBe(true);
  await page.goto("/?symbol=005930");
  await expect(row(page, "086520")).toContainText("에코프로");
  const before = await readServer(page);
  let removals = 0;
  let restores = 0;
  await page.route("**/api/watchlists", async (route) => {
    if (route.request().method() !== "PUT") return route.continue();
    if (route.request().postDataJSON().lists[0].symbols.includes("086520")) restores++;
    else if (++removals > 2) return route.continue();
    await route.fulfill({ status: 500, json: { error: { code: "internal", message: "저장 실패" } } });
  });
  await row(page, "086520").click({ button: "right" });
  await page.getByRole("menuitem", { name: /^관심종목에서 빼기/ }).click();
  await expect(page.getByRole("contentinfo").getByRole("alert")).toContainText("저장하지 못했습니다");
  await page.clock.install();
  await page.getByRole("button", { name: "되돌리기", exact: true }).click();
  await expect(page.getByRole("status").getByText("관심종목을 확인하지 못해 되돌리지 않았습니다. 다시 불러와 주세요")).toBeVisible();
  await page.clock.runFor(60_000);
  expect(await readServer(page)).toEqual(before);
  expect({ removals, restores }).toEqual({ removals: 2, restores: 1 });
});

test("조건부 저장 ACK 전에 새로고침해도 옛 실패 본문을 다시 보내지 않는다", async ({ page }) => {
  expect((await page.request.put("/api/watchlists", { data: { revision: 100, lists: [
    { id: "source", name: "기본", symbols: ["005930", "086520", "005935"] },
  ] } })).ok()).toBe(true);
  await page.goto("/?symbol=005930");
  await expect(row(page, "086520")).toContainText("에코프로");
  let removals = 0;
  let accepted = false;
  let release = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/watchlists", async (route) => {
    if (route.request().method() !== "PUT") return route.continue();
    if (!route.request().postDataJSON().lists[0].symbols.includes("086520")) {
      if (++removals <= 2) return route.fulfill({ status: 500, json: { error: { code: "internal", message: "저장 실패" } } });
      return route.continue();
    }
    const response = await route.fetch();
    expect(response.ok()).toBe(true);
    accepted = true;
    await gate;
    await route.fulfill({ response }).catch(() => {});
  });
  await row(page, "086520").click({ button: "right" });
  await page.getByRole("menuitem", { name: /^관심종목에서 빼기/ }).click();
  await expect(page.getByRole("contentinfo").getByRole("alert")).toContainText("저장하지 못했습니다");
  await page.getByRole("button", { name: "되돌리기", exact: true }).click();
  await expect.poll(() => accepted).toBe(true);
  await page.reload();
  release();
  await expect(row(page, "086520")).toBeVisible();
  expect((await serverLists(page))[0].symbols).toEqual(["005930", "086520", "005935"]);
  expect(removals).toBe(2);
});

test("조건부 저장 충돌은 세 번까지만 재조회하고 최신 자료를 그대로 둔다", async ({ page }) => {
  await prepare(page);
  let puts = 0;
  await page.route("**/api/watchlists", async (route) => {
    if (route.request().method() !== "PUT") return route.continue();
    puts++;
    const latest = await readServer(page);
    const written = await page.request.put("/api/watchlists", { data: { ...latest, revision: latest.revision + 1 } });
    expect(written.ok()).toBe(true);
    await route.continue();
  });
  await page.getByRole("button", { name: "되돌리기", exact: true }).click();
  await expect(conflict(page)).toBeVisible();
  expect(puts).toBe(3);
  expect((await serverLists(page))[0].symbols).toEqual(["005930", "005935"]);
  expect(await rowCodes(page)).toEqual(["005930", "005935"]);
});

test("다른 로컬 편집이 없는 조건부 저장 성공 뒤 자동 저장을 한 번 더 보내지 않는다", async ({ page }) => {
  await prepare(page);
  const before = await readServer(page);
  let puts = 0;
  const bodies: { revision: number }[] = [];
  page.on("request", (request) => {
    if (request.method() === "PUT" && request.url().endsWith("/api/watchlists")) { puts++; bodies.push(request.postDataJSON()); }
  });
  await page.getByRole("button", { name: "되돌리기", exact: true }).click();
  await expect.poll(async () => (await serverLists(page))[0].symbols).toEqual(["005930", "086520", "005935"]);
  await expect(page.getByRole("contentinfo")).toContainText("자동 저장됨");
  expect(puts).toBe(1);
  expect(bodies[0]!.revision).toBe(before.revision + 1);
  await row(page, "005935").locator("[data-main]").press("Alt+ArrowUp");
  await expect.poll(async () => (await serverLists(page))[0].symbols).toEqual(["005930", "005935", "086520"]);
  expect(bodies[1]!.revision).toBeGreaterThan(bodies[0]!.revision);
});

test("조회 중 로컬 순서 변경을 늦은 되돌리기가 덮지 않는다", async ({ page }, info) => {
  await prepare(page);
  const held = await holdReads(page);
  await page.getByRole("button", { name: "되돌리기", exact: true }).click();
  await expect.poll(() => held.reads).toBeGreaterThan(0);
  await row(page, "005935").locator("[data-main]").press("Alt+ArrowUp");
  await expect.poll(async () => (await serverLists(page))[0].symbols).toEqual(["005935", "005930"]);
  held.release();
  await page.unrouteAll({ behavior: "wait" });
  expect(await rowCodes(page)).toEqual(["005935", "005930"]);
  expect((await serverLists(page))[0].symbols).toEqual(["005935", "005930"]);
  await writeFile(info.outputPath("slow-local.json"), JSON.stringify({ reads: held.reads, puts: held.puts, lists: await serverLists(page) }, null, 2));
});

test("느린 되돌리기를 두 번 눌러도 조건부 저장은 한 번만 실행한다", async ({ page }, info) => {
  await prepare(page);
  const held = await holdReads(page);
  await page.getByRole("button", { name: "되돌리기", exact: true }).evaluate((button) => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await expect.poll(() => held.reads).toBeGreaterThan(0);
  await expect(page.getByRole("button", { name: "되돌리기", exact: true })).toHaveCount(0);
  expect(await rowCodes(page)).toEqual(["005930", "005935"]);
  held.release();
  await expect.poll(async () => (await serverLists(page))[0].symbols).toEqual(["005930", "086520", "005935"]);
  await page.unrouteAll({ behavior: "wait" });
  expect(held.puts).toBe(1);
  await writeFile(info.outputPath("slow-double.json"), JSON.stringify({ reads: held.reads, puts: held.puts, lists: await serverLists(page) }, null, 2));
});
