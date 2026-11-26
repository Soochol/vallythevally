import type { CollectorAccessState } from "../src/api/generated/CollectorAccessState";
import type { CollectorCoverage } from "../src/api/generated/CollectorCoverage";
import type { CollectorDisk } from "../src/api/generated/CollectorDisk";
import type { CollectorStatus } from "../src/api/generated/CollectorStatus";
import type { CollectorStatusPage } from "../src/api/generated/CollectorStatusPage";
import type { DaemonJudgment } from "../src/api/generated/DaemonJudgment";
import { expect, test, type Scenario } from "./harness";

const GB = 1024 ** 3;
const RECEIVED_AT = Date.parse("2026-11-18T09:30:12+09:00") / 1000;

const STATUS: CollectorStatus = {
  date: 20261118,
  phase: "collecting",
  today: { planned_stocks: 2600, receiving_stocks: 2380, register_failed_batches: 1, disconnected_stocks: 190, handed_off_stocks: 30, excluded_stocks: 12 },
  keys: [
    { name: "수집-01", app_key_hash_prefix: "a1b2c3d4", role: "collecting", state: "receiving", stocks: 190, messages_per_second: 412.5, register_failures: 0, restarts: 0, rest: { planned_jobs: 0, finished_jobs: 0 } },
  ],
  universe_changes: { added: [], removed: [], renamed: [], halt_started: [], halt_lifted: [] },
  observation_day: { verdict: "observed", reasons: ["평일이고 공휴일이 아니다"] },
  alerts: [],
};

const COVERAGE: CollectorCoverage = { sent_at: "2026-11-18T09:30:12+09:00", days: [] };
const DISK: CollectorDisk = { sent_at: "2026-11-18T09:30:12+09:00", disk: { filesystem: { free_bytes: 800 * GB, total_bytes: 2048 * GB }, raw: [], store: [] } };
const statusPage = (judgment: DaemonJudgment, status: CollectorStatus | null = STATUS): CollectorStatusPage => ({
  judgment,
  status,
  sent_at: status ? "2026-11-18T09:30:12+09:00" : null,
  received_at: status ? RECEIVED_AT : null,
});

function serve(scenario: Scenario, access: CollectorAccessState, status: CollectorStatusPage = statusPage("healthy")) {
  scenario.reply("/api/collector/access", { body: { access } });
  scenario.reply("/api/collector/status", { body: status });
  scenario.reply("/api/collector/coverage", { body: COVERAGE });
  scenario.reply("/api/collector/disk", { body: DISK });
}

test.describe("360px 폭", () => {
  test.use({ viewport: { width: 360, height: 800 } });

  test("현황판 페이지는 가로로 스크롤되지 않는다", async ({ page: p, scenario }) => {
    serve(scenario, "allowed", statusPage("down"));
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
    serve(scenario, "allowed", statusPage("healthy", status));
    await p.goto("/collector");
    await expect(p.getByRole("list", { name: "관측일 판단 근거" })).toContainText(long);
    await expect.poll(() => p.locator("main").evaluate((main) => main.scrollWidth - main.clientWidth)).toBe(0);
  });

  test("공백 없는 긴 모르는 판단·단계·판정·경보 종류가 있어도 현황판 main이 가로로 넘치지 않는다", async ({ page: p, scenario }) => {
    const long = "x".repeat(240);
    const status = {
      ...STATUS,
      phase: long,
      observation_day: { verdict: long, reasons: [] },
      alerts: [{ at: "2026-11-18T07:35:00+09:00", kind: long, message: "알 수 없는 종류" }],
    } as unknown as CollectorStatus;
    serve(scenario, "allowed", statusPage(long as DaemonJudgment, status));
    await p.goto("/collector");
    await expect(p.getByRole("status", { name: "감독 데몬" })).toContainText(long);
    await expect.poll(() => p.locator("main").evaluate((main) => main.scrollWidth - main.clientWidth)).toBe(0);
  });
});
