import type { Page } from "@playwright/test";
import type { CollectorAccessState } from "../src/api/generated/CollectorAccessState";
import type { CollectorCoverage } from "../src/api/generated/CollectorCoverage";
import type { CollectorDisk } from "../src/api/generated/CollectorDisk";
import type { CollectorStatus } from "../src/api/generated/CollectorStatus";
import type { CollectorStatusPage } from "../src/api/generated/CollectorStatusPage";
import type { DaemonJudgment } from "../src/api/generated/DaemonJudgment";
import { cell, expect, test, type Scenario } from "./harness";

const GB = 1024 ** 3;
const RECEIVED_AT = Date.parse("2026-11-18T09:30:12+09:00") / 1000;

const STATUS: CollectorStatus = {
  date: 20261118,
  phase: "collecting",
  today: { planned_stocks: 2600, receiving_stocks: 2380, register_failed_batches: 1, disconnected_stocks: 190, handed_off_stocks: 30, excluded_stocks: 12 },
  keys: [
    { name: "수집-01", app_key_hash_prefix: "a1b2c3d4", role: "collecting", state: "receiving", stocks: 190, messages_per_second: 412.5, register_failures: 0, restarts: 0, rest: { planned_jobs: 0, finished_jobs: 0 } },
    { name: "수집-02", app_key_hash_prefix: "e5f6a7b8", role: "collecting", state: "disconnected", stocks: 190, messages_per_second: null, register_failures: 1, restarts: 3, rest: { planned_jobs: 8, finished_jobs: 5 } },
    { name: "예비-01", app_key_hash_prefix: "99aa00bb", role: "spare", state: "handed_off", stocks: 0, messages_per_second: 0, register_failures: 0, restarts: 0, rest: { planned_jobs: 0, finished_jobs: 0 } },
  ],
  universe_changes: {
    added: [{ code: "123456", name: "새로상장" }],
    removed: [{ code: "654321", name: "상장폐지" }, { code: "111111", name: "함께폐지" }],
    renamed: [{ code: "005930", from: "삼성전자", to: "삼성전자홀딩스" }],
    halt_started: [{ code: "222222", name: "정지시작" }],
    halt_lifted: [{ code: "333333", name: "정지해제" }],
  },
  observation_day: { verdict: "observed", reasons: ["평일이고 공휴일이 아니다", "KRX 휴장일 목록에 없다"] },
  alerts: [
    { at: "2026-11-18T07:35:00+09:00", kind: "plan_note", message: "전날보다 종목이 3% 넘게 줄어 가장 최근 목록을 씁니다" },
    { at: "2026-11-18T09:12:40+09:00", kind: "key_stopped", message: "수집-02 키가 멈췄습니다" },
  ],
};

const COVERAGE: CollectorCoverage = {
  sent_at: "2026-11-18T09:30:12+09:00",
  days: [
    { date: 20261117, state: "complete", verified: true, planned_stocks: 2600, received_stocks: 2588 },
    { date: 20261116, state: "verify_failed", verified: null, planned_stocks: null, received_stocks: null },
  ],
};

const DISK: CollectorDisk = {
  sent_at: "2026-11-18T09:30:12+09:00",
  disk: {
    filesystem: { free_bytes: 800 * GB, total_bytes: 2048 * GB },
    raw: [{ date: 20261118, bytes: 12 * GB }, { date: 20261117, bytes: 30 * GB }],
    store: [{ date: 20261117, bytes: 20 * GB }],
  },
};

const page = (judgment: DaemonJudgment, status: CollectorStatus | null = STATUS): CollectorStatusPage => ({ judgment, status, sent_at: status ? "2026-11-18T09:30:12+09:00" : null, received_at: status ? RECEIVED_AT : null });

function serve(scenario: Scenario, access: CollectorAccessState, status: CollectorStatusPage = page("healthy")) {
  scenario.reply("/api/collector/access", { body: { access } });
  scenario.reply("/api/collector/status", { body: status });
  scenario.reply("/api/collector/coverage", { body: COVERAGE });
  scenario.reply("/api/collector/disk", { body: DISK });
}

const systemButton = (p: Page) => p.getByRole("button", { name: "시스템 설정", exact: true });
const dialog = (p: Page) => p.getByRole("dialog", { name: "시스템 설정", exact: true });
const menuItem = (p: Page) => dialog(p).getByRole("tab", { name: "수집 현황판" });

async function openSettings(p: Page) {
  await p.goto("/?symbol=005930");
  await expect(cell(p)).toHaveAttribute("aria-busy", "false");
  await systemButton(p).click();
  await expect(dialog(p)).toBeVisible();
}

test("권한이 허용이면 메뉴 항목이 보이고 현황판에 모든 구역이 보인다", async ({ page: p, scenario }) => {
  serve(scenario, "allowed");
  await openSettings(p);
  await menuItem(p).click();
  const panel = dialog(p).getByRole("tabpanel");

  await expect(panel.getByRole("status", { name: "감독 데몬" })).toContainText("감독 데몬이 정상으로 돕니다");
  await expect(panel.getByRole("status", { name: "감독 데몬" })).toContainText("2026-11-18 09:30:12");

  const today = panel.getByRole("region", { name: "오늘의 요약" });
  await expect(today).toContainText("2026-11-18 · 장중 수집");
  for (const [label, value] of [["계획 종목", "2,600"], ["받는 중", "2,380"], ["등록 실패", "1"], ["끊김", "190"], ["인계됨", "30"], ["제외", "12"]] as const) {
    await expect(today.locator("div", { has: p.getByText(label, { exact: true }) }).first()).toContainText(value);
  }

  const keys = panel.getByRole("table", { name: "키별 상태" });
  await expect(keys.getByRole("row", { name: /수집-01/ })).toContainText("받는 중");
  await expect(keys.getByRole("row", { name: /수집-01/ })).toContainText("412.5");
  await expect(keys.getByRole("row", { name: /수집-01/ })).toContainText("없음");
  await expect(keys.getByRole("row", { name: /수집-02/ })).toContainText("끊김");
  await expect(keys.getByRole("row", { name: /수집-02/ })).toContainText("5 / 8");
  await expect(keys.getByRole("row", { name: /예비-01/ })).toContainText("예비 키");
  await expect(keys.getByRole("row", { name: /예비-01/ })).toContainText("인계됨");

  const universe = panel.getByRole("region", { name: "종목 목록 변동" });
  await expect(universe).toContainText("123456 새로상장");
  await expect(universe).toContainText("654321 상장폐지");
  await expect(universe).toContainText("005930 삼성전자 → 삼성전자홀딩스");
  await expect(universe).toContainText("222222 정지시작");
  await expect(universe).toContainText("333333 정지해제");
  await expect(universe.getByRole("list", { name: "종목 목록 안내" })).toContainText("가장 최근 목록을 씁니다");

  const observation = panel.getByRole("region", { name: "관측일 판단" });
  await expect(observation).toContainText("관측일");
  await expect(observation.getByRole("list", { name: "관측일 판단 근거" })).toContainText("KRX 휴장일 목록에 없다");

  await expect(panel.getByRole("list", { name: "경보 목록" })).toContainText("수집-02 키가 멈췄습니다");

  await expect(panel.getByRole("table", { name: "날짜별 커버리지" }).getByRole("row", { name: /2026-11-17/ })).toContainText("2,588 / 2,600");
  await expect(panel.getByRole("table", { name: "날짜별 커버리지" }).getByRole("row", { name: /2026-11-16/ })).toContainText("대조 실패");

  const disk = panel.getByRole("region", { name: "디스크 사용량" });
  await expect(disk).toContainText("800 GB");
  await expect(disk.getByRole("table", { name: "날짜별 디스크 사용량" }).getByRole("row", { name: /2026-11-17/ })).toContainText("30.0 GB");
});

test("권한이 꺼짐이거나 없음이면 메뉴 항목이 없다", async ({ page: p, scenario }) => {
  for (const access of ["off", "denied"] as const) {
    serve(scenario, access);
    await openSettings(p);
    await expect(dialog(p).getByRole("tab", { name: "계정" })).toBeVisible();
    await expect(menuItem(p)).toHaveCount(0);
    await p.keyboard.press("Escape");
    await expect(dialog(p)).toHaveCount(0);
  }
});

test("설정 창을 다시 열면 권한을 다시 묻고 바뀐 권한을 따른다", async ({ page: p, scenario }) => {
  serve(scenario, "allowed");
  await openSettings(p);
  await expect(menuItem(p)).toBeVisible();
  await p.keyboard.press("Escape");
  await expect(dialog(p)).toHaveCount(0);

  scenario.reply("/api/collector/access", { body: { access: "denied" } });
  await systemButton(p).click();
  await expect(dialog(p).getByRole("tab", { name: "계정" })).toBeVisible();
  await expect(menuItem(p)).toHaveCount(0);
});

test("권한이 없으면 주소로 직접 열어도 현황판을 그리지 않고 차트로 돌아간다", async ({ page: p, scenario }) => {
  serve(scenario, "denied");
  await p.goto("/collector");
  await expect(p).toHaveURL(/\/$/);
  await expect(p.getByRole("heading", { name: "수집 현황판" })).toHaveCount(0);
});

test("권한이 허용이면 주소로 현황판 페이지가 열린다", async ({ page: p, scenario }) => {
  serve(scenario, "allowed");
  await p.goto("/collector");
  await expect(p.getByRole("heading", { name: "수집 현황판", level: 1 })).toBeVisible();
  await expect(p.getByRole("table", { name: "키별 상태" })).toBeVisible();
});

test("데몬이 꺼져 있으면 경고 띠와 마지막으로 받은 상태의 시각을 보인다", async ({ page: p, scenario }) => {
  serve(scenario, "allowed", page("down"));
  await p.goto("/collector");
  const band = p.getByRole("alert", { name: "감독 데몬" });
  await expect(band).toContainText("감독 데몬이 꺼져 있습니다");
  await expect(band).toContainText("마지막으로 받은 상태 2026-11-18 09:30:12");
  await expect(band).toHaveAttribute("data-judgment", "down");
});

test("데몬이 응답하지 않으면 경고 띠를 보이고 받은 상태가 없으면 그렇게 적는다", async ({ page: p, scenario }) => {
  serve(scenario, "allowed", page("unresponsive", null));
  await p.goto("/collector");
  const band = p.getByRole("alert", { name: "감독 데몬" });
  await expect(band).toContainText("감독 데몬이 응답하지 않습니다");
  await expect(band).toContainText("받은 상태 없음");
  await expect(p.getByText("감독 데몬에서 받은 상태가 아직 없습니다.")).toBeVisible();
});

test("실시간 알림 프레임이 오면 화면 안 알림을 띄운다", async ({ page: p, scenario }) => {
  serve(scenario, "allowed");
  await p.goto("/collector");
  await expect(p.getByRole("table", { name: "키별 상태" })).toBeVisible();
  scenario.live.emit({ type: "collector_daemon", judgment: "down", at: RECEIVED_AT });
  await expect(p.getByRole("status").filter({ hasText: "수집 감독 데몬이 꺼졌습니다" })).toBeVisible();
  scenario.live.emit({ type: "collector_daemon", judgment: "unresponsive", at: RECEIVED_AT });
  await expect(p.getByRole("status").filter({ hasText: "수집 감독 데몬이 응답하지 않습니다" })).toBeVisible();
});

test("정상으로 돌아왔다는 알림 프레임은 알림을 띄우지 않는다", async ({ page: p, scenario }) => {
  serve(scenario, "allowed");
  await p.goto("/collector");
  await expect(p.getByRole("table", { name: "키별 상태" })).toBeVisible();
  scenario.live.emit({ type: "collector_daemon", judgment: "healthy", at: RECEIVED_AT });
  scenario.live.emit({ type: "collector_daemon", judgment: "down", at: RECEIVED_AT });
  await expect(p.getByRole("status").filter({ hasText: "수집 감독 데몬이 꺼졌습니다" })).toBeVisible();
});

test("브라우저 알림은 사용자가 단추를 눌러 허락한 뒤에만 뜬다", async ({ page: p, scenario }) => {
  await p.addInitScript(() => {
    const shown: string[] = [];
    let permission: NotificationPermission = "default";
    class FakeNotification {
      static get permission() { return permission; }
      static requestPermission() { permission = "granted"; return Promise.resolve(permission); }
      constructor(title: string, options: NotificationOptions) { shown.push(`${title}|${options.body}`); }
    }
    Object.assign(window, { Notification: FakeNotification, shownNotifications: shown });
  });
  serve(scenario, "allowed");
  await p.goto("/collector");
  const shown = () => p.evaluate(() => (window as unknown as { shownNotifications: string[] }).shownNotifications);

  scenario.live.emit({ type: "collector_daemon", judgment: "down", at: RECEIVED_AT });
  await expect(p.getByRole("status").filter({ hasText: "수집 감독 데몬이 꺼졌습니다" })).toBeVisible();
  expect(await shown()).toEqual([]);

  await p.getByRole("button", { name: "브라우저 알림 허용" }).click();
  await expect(p.getByText("브라우저 알림 켜짐")).toBeVisible();
  scenario.live.emit({ type: "collector_daemon", judgment: "unresponsive", at: RECEIVED_AT });
  await expect.poll(shown).toEqual(["수집 현황판|수집 감독 데몬이 응답하지 않습니다"]);
});

test("읽기 전용이라 재시작·인계 같은 조작 단추가 없다", async ({ page: p, scenario }) => {
  await p.addInitScript(() => Object.assign(window, { Notification: undefined }));
  serve(scenario, "allowed");
  await p.goto("/collector");
  await expect(p.getByRole("table", { name: "키별 상태" })).toBeVisible();
  await expect(p.getByRole("button", { name: /재시작|인계|멈춤|중지|시작|전환/ })).toHaveCount(0);
  const names = await p.getByRole("button").evaluateAll((buttons) => buttons.map((b) => b.textContent?.trim() ?? ""));
  expect(names.filter((n) => n !== "")).toEqual([]);
});

test("커버리지와 디스크를 받지 못해도 나머지 구역은 보이고 다시 시도할 수 있다", async ({ page: p, scenario }) => {
  serve(scenario, "allowed");
  scenario.reply("/api/collector/coverage", { status: 503, body: { error: { code: "collector_unavailable", message: "감독 데몬이 응답하지 않습니다", reason: null, retryAt: null, manualActionRequired: false } } });
  await p.goto("/collector");
  await expect(p.getByRole("table", { name: "키별 상태" })).toBeVisible();
  await expect(p.getByRole("alert").filter({ hasText: "커버리지를 받지 못했습니다" })).toBeVisible();
  await expect(p.getByRole("region", { name: "디스크 사용량" })).toContainText("800 GB");
});

test("모르는 판단 값은 값 그대로 보이고 앱이 죽지 않는다", async ({ page: p, scenario }) => {
  serve(scenario, "allowed", page("starting" as DaemonJudgment));
  await openSettings(p);
  await menuItem(p).click();
  const band = dialog(p).getByRole("status", { name: "감독 데몬" });
  await expect(band).toContainText("starting");
  await expect(band).toHaveAttribute("data-judgment", "starting");
  await expect(p.getByText("Unexpected Application Error")).toHaveCount(0);
  await expect(dialog(p).getByRole("table", { name: "키별 상태" })).toBeVisible();
});

for (const receivedAt of [9e12, 8.64e12, 8.64e12 - 100]) {
  test(`범위 밖 received_at ${receivedAt}은 알 수 없는 시각으로 보인다`, async ({ page: p, scenario }) => {
    serve(scenario, "allowed", { ...page("healthy"), received_at: receivedAt });
    await p.goto("/collector");
    const band = p.getByRole("status", { name: "감독 데몬" });
    await expect(band).toContainText("마지막으로 받은 상태 알 수 없는 시각");
    await expect(band).not.toContainText("NaN");
    await expect(band.locator("time")).toHaveCount(0);
    await expect(p.getByRole("table", { name: "키별 상태" })).toBeVisible();
  });
}

test("현황판을 그리다 오류가 나도 차트 화면과 설정 창의 다른 메뉴는 남는다", async ({ page: p, scenario }) => {
  const broken = { ...STATUS, keys: null } as unknown as CollectorStatus;
  serve(scenario, "allowed", page("healthy", broken));
  await openSettings(p);
  await menuItem(p).click();
  await expect(dialog(p).getByRole("alert")).toContainText("수집 현황판을 그리지 못했습니다");
  await expect(p.getByText("Unexpected Application Error")).toHaveCount(0);
  await expect(cell(p)).toBeVisible();
  await dialog(p).getByRole("tab", { name: "계정" }).click();
  await expect(dialog(p).getByRole("tabpanel")).not.toContainText("수집 현황판을 그리지 못했습니다");
});

test.describe("360px 폭", () => {
  test.use({ viewport: { width: 360, height: 800 } });

  test("현황판 페이지는 가로로 스크롤되지 않는다", async ({ page: p, scenario }) => {
    serve(scenario, "allowed", page("down"));
    await p.goto("/collector");
    await expect(p.getByRole("table", { name: "키별 상태" })).toBeVisible();
    await expect.poll(() => p.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
  });

  test("공백 없는 긴 낱말이 있어도 현황판 main이 가로로 넘치지 않는다", async ({ page: p, scenario }) => {
    const long = "가".repeat(120) + "A".repeat(120);
    const status: CollectorStatus = {
      ...STATUS,
      observation_day: { verdict: "observed", reasons: [long] },
      alerts: [{ at: "2026-11-18T07:35:00+09:00", kind: "plan_note", message: long }],
    };
    serve(scenario, "allowed", page("healthy", status));
    await p.goto("/collector");
    await expect(p.getByRole("list", { name: "관측일 판단 근거" })).toContainText(long);
    await expect(p.getByRole("list", { name: "종목 목록 안내" })).toContainText(long);
    await expect.poll(() => p.locator("main").evaluate((main) => main.scrollWidth - main.clientWidth)).toBe(0);
  });
});
