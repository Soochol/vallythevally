import type { Page } from "@playwright/test";
import type { Layout } from "../src/api/generated/Layout";
import { cell, DEFAULT_LAYOUT_ID, expect, firstChart, test } from "./harness";

test.use({ clockStart: "20261109100000" });
const topbar = (page: Page) => page.getByRole("toolbar", { name: "차트 도구 막대" });
const trigger = (page: Page) => topbar(page).getByRole("button", { name: /^레이아웃:/ });
const menu = (page: Page) => page.getByRole("menu", { name: "레이아웃", exact: true });
const inspector = (page: Page) => page.getByRole("region", { name: "지표", exact: true });
async function choose(page: Page, name: string) {
  await trigger(page).click();
  await menu(page).getByRole("menuitemradio", { name, exact: true }).click();
  await expect(trigger(page)).toHaveAccessibleName(`레이아웃: ${name}`);
}
async function action(page: Page, name: string) {
  await trigger(page).click();
  await menu(page).getByRole("menuitem", { name, exact: true }).click();
}
async function nameLayout(page: Page, kind: "새 이름으로 저장" | "이름 바꾸기", name: string) {
  await action(page, `${kind}…`);
  const dialog = page.getByRole("dialog", { name: kind, exact: true });
  await dialog.getByRole("textbox", { name: "레이아웃 이름" }).fill(name);
  await dialog.getByRole("button", { name: "저장", exact: true }).click();
  return dialog;
}
async function symbol(page: Page, code: string) {
  await topbar(page).getByTitle("종목 바꾸기").click();
  const dialog = page.getByRole("dialog", { name: "종목 검색", exact: true });
  await dialog.getByRole("combobox", { name: "종목 검색" }).fill(code);
  await dialog.getByRole("option").filter({ hasText: code }).click();
}

test.beforeEach(async ({ page }) => { await page.setViewportSize({ width: 1440, height: 900 }); });

test("긴 레이아웃 이름도 좁은 위 막대 안에 보이고 전체 이름으로 메뉴를 연다", async ({ page, scenario }) => {
  const name = "가나다라마바사아자차카타파하가나다라마바";
  scenario.documents.saveLayout({ ...scenario.documents.layout(), name, revision: 1 });
  for (const width of [768, 800, 1024]) {
    await page.setViewportSize({ width, height: 700 });
    await page.goto("/");
    await expect(cell(page)).toHaveAttribute("aria-busy", "false");
    await expect(trigger(page)).toHaveAccessibleName(`레이아웃: ${name}`);
    const bar = await topbar(page).boundingBox();
    for (const button of await topbar(page).getByRole("button").all()) {
      const box = await button.boundingBox();
      expect(box!.x + box!.width).toBeLessThanOrEqual(bar!.x + bar!.width + 1);
    }
    await trigger(page).click();
    await expect(menu(page).getByRole("menuitemradio", { name, exact: true })).toHaveAttribute("aria-checked", "true");
    await page.keyboard.press("Escape");
  }
});

test("새 이름 저장 전 원본에도 편집을 저장하고 이후 따로 바꾼 창·종목·봉 주기를 전환과 새로고침 뒤 지킨다", async ({ page, scenario }) => {
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await topbar(page).getByRole("button", { name: "창 더하기", exact: true }).click();
  await page.getByRole("menu", { name: "창 더하기" }).getByRole("menuitem", { name: /^차트/ }).click();
  await expect(cell(page, 2)).toBeVisible();
  await symbol(page, "005930");
  await topbar(page).getByRole("button", { name: "주", exact: true }).click();
  await expect(cell(page, 2)).toHaveAttribute("aria-label", "칸 2: 삼성전자 통합 주");
  await expect(await nameLayout(page, "새 이름으로 저장", "복기")).toBeHidden();
  expect(scenario.documents.layout(DEFAULT_LAYOUT_ID).windows.filter((window) => window.kind === "chart")).toHaveLength(2);
  const copyId = scenario.documents.layoutSummaries().find((entry) => entry.name === "복기")!.id;
  await trigger(page).click();
  await expect(menu(page).getByRole("menuitemradio")).toHaveText(["기본", "복기"]);
  await expect(menu(page).getByRole("menuitemradio", { name: "복기", exact: true })).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");

  await choose(page, "기본");
  await expect(cell(page, 2)).toBeVisible();
  await page.getByRole("button", { name: "칸 2 삼성전자 닫기", exact: true }).click();
  await symbol(page, "000660");
  await topbar(page).getByRole("button", { name: "월", exact: true }).click();
  await choose(page, "복기");
  await expect(cell(page, 2)).toHaveAttribute("aria-label", "칸 2: 삼성전자 통합 주");
  await cell(page, 2).click();
  await symbol(page, "086520");
  await choose(page, "기본");
  await expect(cell(page, 2)).toHaveCount(0);
  await expect(cell(page)).toHaveAttribute("aria-label", "칸 1: SK하이닉스 통합 월");
  await choose(page, "복기");
  await expect(cell(page, 2)).toHaveAttribute("aria-label", "칸 2: 에코프로 통합 주");
  await expect.poll(() => scenario.documents.uiPrefs().lastLayoutId).toBe(copyId);
  await page.reload();
  await expect(trigger(page)).toHaveAccessibleName("레이아웃: 복기");
  await expect(cell(page, 2)).toHaveAttribute("aria-label", "칸 2: 에코프로 통합 주");
  expect(firstChart(scenario.documents.layout(DEFAULT_LAYOUT_ID))).toMatchObject({ symbol: "000660", period: "M" });
});

test("이름 규칙과 서버 거절을 표시하고 이름 바꾸기·지우기 뒤 목록을 갱신한다", async ({ page, scenario }) => {
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await nameLayout(page, "새 이름으로 저장", "복기");
  await expect(trigger(page)).toHaveAccessibleName("레이아웃: 복기");
  const duplicate = await nameLayout(page, "이름 바꾸기", " 기본 ");
  await expect(duplicate).toContainText("같은 이름의 레이아웃이 있습니다");
  await duplicate.getByRole("textbox").fill(" ");
  await duplicate.getByRole("button", { name: "저장", exact: true }).click();
  await expect(duplicate).toContainText("1~20자");
  await duplicate.getByRole("textbox").fill("리뷰");
  scenario.reply((url, request) => url.pathname.startsWith("/api/layouts/") && request.method() === "PUT", { status: 409, body: { error: { code: "conflict", message: "서버의 이름 중복" } } });
  await duplicate.getByRole("button", { name: "저장", exact: true }).click();
  await expect(duplicate).toContainText("서버의 이름 중복");
  scenario.reply((url, request) => url.pathname.startsWith("/api/layouts/") && request.method() === "PUT", { status: 400, body: { error: { code: "bad_request", message: "서버의 이름 규칙" } } });
  await duplicate.getByRole("button", { name: "저장", exact: true }).click();
  await expect(duplicate).toContainText("서버의 이름 규칙");
  scenario.on((url, request) => url.pathname.startsWith("/api/layouts/") && request.method() === "PUT", (request) => ({ body: scenario.documents.saveLayout(request.postDataJSON()) }));
  await duplicate.getByRole("button", { name: "저장", exact: true }).click();
  await expect(trigger(page)).toHaveAccessibleName("레이아웃: 리뷰");
  await action(page, "지우기");
  await page.getByRole("button", { name: "레이아웃 지우기", exact: true }).click();
  await expect(trigger(page)).toHaveAccessibleName("레이아웃: 기본");
  await trigger(page).click();
  await expect(menu(page).getByRole("menuitemradio")).toHaveText(["기본"]);
  await expect(menu(page).getByRole("menuitem", { name: "지우기", exact: true })).toBeDisabled();
});

test("이 레이아웃 범위의 드로잉이 있으면 지우기를 거절하고 현재 레이아웃을 보존한다", async ({ page, scenario }) => {
  const base = scenario.documents.layout();
  const id = "01900000-0000-7000-8000-0000000000b1";
  scenario.documents.saveLayout({ ...base, id, name: "복기", revision: 1 });
  scenario.documents.saveDrawing({ id: "01900000-0000-7000-8000-0000000000d1", symbol: "005930", tool: "hline", points: [{ t: 1, price: 70_000 }], style: {}, text: null, locked: false, hidden: false, periods: null, z: 1, group: null, scope: { kind: "layout", layoutId: id }, revision: 3 });
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await choose(page, "복기");
  await action(page, "지우기");
  await page.getByRole("button", { name: "레이아웃 지우기", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "이 레이아웃 범위의 드로잉이 있어 지울 수 없습니다" })).toBeVisible();
  await expect(trigger(page)).toHaveAccessibleName("레이아웃: 복기");
  expect(scenario.documents.layoutSummaries()).toHaveLength(2);
});

test("서버가 더 새 저장 순서 때문에 편집을 거절하면 레이아웃을 바꾸지 않고 미저장본을 남긴다", async ({ page, scenario }) => {
  scenario.documents.saveLayout({ ...scenario.documents.layout(), id: "01900000-0000-7000-8000-0000000000b1", name: "복기", revision: 1 });
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  scenario.documents.saveLayout({ ...scenario.documents.layout(), revision: Date.parse("2030-01-01") });
  await topbar(page).getByRole("button", { name: "주", exact: true }).click();
  await trigger(page).click();
  await menu(page).getByRole("menuitemradio", { name: "복기", exact: true }).click();
  await expect(trigger(page)).toBeEnabled();
  await expect(trigger(page)).toHaveAccessibleName("레이아웃: 기본");
  await expect(trigger(page)).toBeFocused();
  await expect(cell(page)).toHaveAttribute("aria-label", / 주$/);
  expect(firstChart(scenario.documents.layout()).period).toBe("D");
  const draft = await page.evaluate(() => {
    const raw = localStorage.getItem("vv.unsaved.layout");
    return raw ? JSON.parse(raw).body : null;
  });
  expect(draft).toContain('"period":"W"');
});

for (const unavailable of [false, true]) {
  test(`지우기 응답을 잃어도 저장을 재개하기 전에 존재 여부를 확인한다: ${unavailable ? "확인 연결도 끊김" : "바로 확인"}`, async ({ page, scenario }) => {
    const id = "01900000-0000-7000-8000-0000000000b1";
    scenario.documents.saveLayout({ ...scenario.documents.layout(), id, name: "복기", revision: 1 });
    await page.goto("/");
    await expect(cell(page)).toHaveAttribute("aria-busy", "false");
    let canCheck = !unavailable;
    scenario.on((url, request) => url.pathname === `/api/layouts/${DEFAULT_LAYOUT_ID}` && request.method() === "GET", () => canCheck
      ? { status: 404, body: { error: { code: "not_found", message: "레이아웃이 없습니다" } } }
      : { status: 503, body: { error: { code: "internal", message: "확인 연결 끊김" } } });
    const deletion = scenario.hold((url, request) => url.pathname === `/api/layouts/${DEFAULT_LAYOUT_ID}` && request.method() === "DELETE");
    await action(page, "지우기");
    await page.getByRole("button", { name: "레이아웃 지우기", exact: true }).click();
    await deletion.received;
    expect(scenario.documents.deleteLayout(DEFAULT_LAYOUT_ID)).toBe(true);
    await topbar(page).getByRole("button", { name: "주", exact: true }).click();
    deletion.reply({ status: 503, body: { error: { code: "internal", message: "지우기 응답 끊김" } } });
    const sourcePuts = () => scenario.requests.filter((request) => request.method() === "PUT" && new URL(request.url()).pathname === `/api/layouts/${DEFAULT_LAYOUT_ID}`);
    if (unavailable) {
      await expect(page.getByRole("status").filter({ hasText: "지우기 결과를 확인하지 못했습니다" })).toBeVisible();
      await page.clock.fastForward(70_000);
      expect(sourcePuts()).toHaveLength(0);
      canCheck = true;
      await trigger(page).click();
    }
    await expect(trigger(page)).toHaveAccessibleName("레이아웃: 복기");
    await expect(trigger(page)).toBeEnabled();
    await page.clock.fastForward(70_000);
    expect(sourcePuts()).toHaveLength(0);
    expect(scenario.documents.layoutSummaries().map((entry) => entry.id)).toEqual([id]);
  });
}

test("닫은 창과 기본 도킹 배치는 메뉴의 배치 되돌리기로 되살린다", async ({ page, scenario }) => {
  const base = scenario.documents.layout();
  const placement = { v: 1, dock: { root: { kind: "split", dir: "row", ratio: 0.3, first: { kind: "group", id: "side", tabs: ["watchlist", "screener", "objects"], active: "watchlist" }, second: { kind: "group", id: "chart", tabs: ["cell-0"], active: "cell-0" } }, floats: [] }, canvas: null };
  scenario.documents.saveLayout({ ...base, placement, revision: 1 });
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  const before = await page.locator("[data-dock-group]").filter({ has: cell(page) }).boundingBox();
  await page.getByRole("button", { name: "스크리너 닫기", exact: true }).click();
  await action(page, "배치 되돌리기");
  await expect(page.getByRole("tab", { name: "스크리너", exact: true })).toBeVisible();
  await action(page, "기본 배치로");
  const chart = await page.locator("[data-dock-group]").filter({ has: cell(page) }).boundingBox();
  const side = await page.locator("[data-dock-group]").filter({ has: page.getByRole("tab", { name: "관심종목", exact: true }) }).boundingBox();
  expect(chart!.x).toBeLessThan(side!.x);
  await expect(page.locator("[data-dock-group]").filter({ has: page.getByRole("tab", { name: "관심종목", exact: true }) }).getByRole("tab")).toHaveText([/^관심종목/, /^스크리너/, /^개체 목록/]);
  await action(page, "배치 되돌리기");
  const restored = await page.locator("[data-dock-group]").filter({ has: cell(page) }).boundingBox();
  expect(restored!.x).toBeCloseTo(before!.x, 0);
});

test("레이아웃 메뉴를 키보드로 열고 이동·선택·닫기와 초점 복귀를 한다", async ({ page, scenario }) => {
  scenario.documents.saveLayout({ ...scenario.documents.layout(), id: "01900000-0000-7000-8000-0000000000b1", name: "복기", revision: 1 });
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await trigger(page).focus();
  await page.keyboard.press("Enter");
  await expect(menu(page).getByRole("menuitemradio", { name: "기본", exact: true })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(menu(page).getByRole("menuitemradio", { name: "복기", exact: true })).toBeFocused();
  await page.keyboard.press("End");
  await expect(menu(page).getByRole("menuitem", { name: "기본 배치로", exact: true })).toBeFocused();
  await page.keyboard.press("Home");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(trigger(page)).toHaveAccessibleName("레이아웃: 복기");
  await expect(trigger(page)).toBeFocused();
  await page.keyboard.press("Space");
  await expect(menu(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu(page)).toBeHidden();
  await expect(trigger(page)).toBeFocused();
});

test("이름 입력을 키보드로 저장·취소하고 서버가 거절해도 초점을 유지한다", async ({ page, scenario }) => {
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  const open = async (kind: "새 이름으로 저장" | "이름 바꾸기") => {
    await expect(trigger(page)).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(menu(page).getByRole("menuitemradio").first()).toBeFocused();
    await page.keyboard.press("Home");
    await page.keyboard.press("ArrowDown");
    if (kind === "이름 바꾸기") await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: kind, exact: true });
    await expect(dialog.getByRole("textbox")).toBeFocused();
    return dialog;
  };
  await trigger(page).focus();
  const renamed = await open("이름 바꾸기");
  await renamed.getByRole("textbox").fill("키보드");
  await page.keyboard.press("Enter");
  await expect(renamed).toBeHidden();
  await expect(trigger(page)).toHaveAccessibleName("레이아웃: 키보드");
  await expect(trigger(page)).toBeFocused();
  await expect(page.getByRole("contentinfo")).toContainText("자동 저장됨");
  for (const kind of ["이름 바꾸기", "새 이름으로 저장"] as const) {
    const cancelled = await open(kind);
    await page.keyboard.press("Escape");
    await expect(cancelled).toBeHidden();
    await expect(trigger(page)).toBeFocused();
    const rejected = await open(kind);
    await rejected.getByRole("textbox").fill("거절된 이름");
    scenario.reply((url, request) => url.pathname.startsWith("/api/layouts/") && request.method() === "PUT", { status: 409, body: { error: { code: "conflict", message: "서버에서 거절했습니다" } } });
    await page.keyboard.press("Enter");
    await expect(rejected).toContainText("서버에서 거절했습니다");
    await expect(rejected.getByRole("textbox")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(rejected).toBeHidden();
    await expect(trigger(page)).toBeFocused();
  }
});

test("같은 창 id를 가진 레이아웃으로 바꾸면 지표 인스펙터의 검색과 미리보기 초안을 비운다", async ({ page, scenario }) => {
  const base = scenario.documents.layout();
  const withInspector: Layout = { ...base, windows: [...base.windows, { id: "indicators", kind: "indicators", link: null }], placement: {}, revision: 1 };
  scenario.documents.saveLayout(withInspector);
  scenario.documents.saveLayout({ ...withInspector, id: "01900000-0000-7000-8000-0000000000b1", name: "복기" });
  scenario.documents.saveUiState({ ...scenario.documents.uiState(), indicatorWindow: "inspector", revision: 1 });
  await page.goto("/");
  await expect(cell(page)).toHaveAttribute("aria-busy", "false");
  await topbar(page).getByRole("button", { name: "지표", exact: true }).click();
  await inspector(page).getByRole("searchbox", { name: "지표·비교 찾기" }).fill("이평 9");
  await expect(inspector(page).getByRole("button", { name: "이동평균 단순 9 추가 후보", exact: true })).toHaveAttribute("aria-expanded", "true");
  await choose(page, "복기");
  await topbar(page).getByRole("button", { name: "지표", exact: true }).click();
  await expect(inspector(page).getByRole("searchbox", { name: "지표·비교 찾기" })).toHaveValue("");
  await expect(inspector(page).getByRole("button", { name: "이동평균 단순 9 추가 후보", exact: true })).toHaveCount(0);
  await expect(cell(page).getByText("이동평균 단순 9", { exact: true })).toHaveCount(0);
});

for (const roundTrip of [false, true]) {
  test(`이전 레이아웃의 주소 종목 조회는 전환 뒤 적용하지 않는다: ${roundTrip ? "원래 레이아웃으로 돌아옴" : "다른 레이아웃"}`, async ({ page, scenario }) => {
    const id = "01900000-0000-7000-8000-0000000000b1";
    scenario.documents.saveLayout({ ...scenario.documents.layout(), id, name: "복기", revision: 1 });
    const pending = scenario.hold("/api/symbols/005930");
    await page.goto("/?symbol=005930&period=W");
    await pending.received;
    await expect(cell(page)).toHaveAttribute("aria-busy", "false");
    await choose(page, "복기");
    if (roundTrip) await choose(page, "기본");
    const response = page.waitForResponse((value) => new URL(value.url()).pathname === "/api/symbols/005930");
    pending.reply({ body: scenario.market.symbols.find((info) => info.code === "005930") });
    await (await response).finished();
    await page.clock.fastForward(5000);
    await expect(cell(page)).toHaveAttribute("aria-label", "칸 1: 코스피 일");
    expect(firstChart(scenario.documents.layout(roundTrip ? DEFAULT_LAYOUT_ID : id))).toMatchObject({ symbol: "IDX:001", period: "D" });
  });
}

test("연결 없이 기본 화면으로 열면 레이아웃 메뉴가 비활성이다", async ({ page, scenario }) => {
  scenario.reply("/api/ui-state", { status: 503, body: { error: { code: "internal", message: "연결 끊김" } } });
  await page.goto("/");
  await expect(trigger(page)).toBeDisabled();
  await expect(page.getByRole("status").filter({ hasText: "서버에 연결하지 못해 기본 화면으로 열었습니다" }).first()).toBeVisible();
});
