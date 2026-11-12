import type { ApiErrorBody } from "../src/api/generated/ApiErrorBody.ts";
import type { ApiErrorCode } from "../src/api/generated/ApiErrorCode.ts";
import type { ApiErrorReason } from "../src/api/generated/ApiErrorReason.ts";
import type { Condition } from "../src/api/generated/Condition.ts";
import type { ExcludeKind } from "../src/api/generated/ExcludeKind.ts";
import type { KstDate } from "../src/api/generated/KstDate.ts";
import type { Screen } from "../src/api/generated/Screen.ts";
import type { ScreenerResult } from "../src/api/generated/ScreenerResult.ts";
import type { ScreenerRow } from "../src/api/generated/ScreenerRow.ts";
import type { ScreenerStatus } from "../src/api/generated/ScreenerStatus.ts";
import type { ScreenerUpdate } from "../src/api/generated/ScreenerUpdate.ts";
import type { ScreenPeriod } from "../src/api/generated/ScreenPeriod.ts";
import type { SymbolKind } from "../src/api/generated/SymbolKind.ts";
import type { UpdatePhase } from "../src/api/generated/UpdatePhase.ts";
import { mulberry32, seedOf, SYMBOLS } from "./fakeMarket.ts";
import { isScreen, type Reply } from "./fakeUserData.ts";

export const FAKE_SCREENER_SCENARIOS = ["ready", "empty", "behind", "failing"] as const;
export type FakeScreenerScenario = (typeof FAKE_SCREENER_SCENARIOS)[number];

export function parseScenario(raw: string | undefined): FakeScreenerScenario {
  if (raw === undefined || raw === "") return "ready";
  const scenario = FAKE_SCREENER_SCENARIOS.find((s) => s === raw);
  if (!scenario) throw new Error(`VITE_FAKE_SCREENER는 ${FAKE_SCREENER_SCENARIOS.join(", ")} 가운데 하나여야 합니다: ${raw}`);
  return scenario;
}

const STOCKS = SYMBOLS.filter((s) => s.kind !== "index" && s.fail === undefined);
const SYMBOLS_PHASE_MS = 1_500;
const RECENT_MS_PER_STOCK = 250;
const BACKFILL_MS_PER_STOCK = 400;
const FAILING_SHARE = 0.4;
const BEHIND_DAYS = 2;
const ONE_PAGE_DAYS = 600;
const CLOSE_HOUR_KST = 20;
const BARS_PER_YEAR: Record<ScreenPeriod, number> = { D: 250, W: 52, M: 12 };
const DAYS_PER_BAR: Record<ScreenPeriod, number> = { D: 1, W: 5, M: 21 };
const EXCLUDED_KIND: Partial<Record<ExcludeKind, SymbolKind>> = { etf: "etf", preferred: "preferred", reit: "reit" };
const KIWOOM_DOWN: ApiErrorBody = {
  code: "kiwoom_unavailable",
  message: "키움 조회가 응답하지 않습니다. 잠시 뒤 다시 시도하세요.",
  reason: "kiwoom_error",
  retryAt: null,
  manualActionRequired: false,
};

const DAY_MS = 86_400_000;
const KST_MS = 9 * 3_600_000;
const isoOf = (ms: number): KstDate => new Date(ms).toISOString().slice(0, 10);
const msOf = (day: KstDate) => Date.parse(`${day}T00:00:00Z`);
const kstToday = (now: number) => isoOf(now + KST_MS);
const isObservationDay = (day: KstDate) => ![0, 6].includes(new Date(msOf(day)).getUTCDay());

function observationDaysBefore(day: KstDate, count: number): KstDate {
  let ms = msOf(day);
  for (let left = count; left > 0; ) {
    ms -= DAY_MS;
    if (isObservationDay(isoOf(ms))) left--;
  }
  return isoOf(ms);
}

const needDayAt = (now: number) => observationDaysBefore(kstToday(now), 1);
const todayConfirmedAt = (now: number) => isObservationDay(kstToday(now)) && new Date(now + KST_MS).getUTCHours() >= CLOSE_HOUR_KST;

function barStart(period: ScreenPeriod, asOf: KstDate, barsAgo: number): KstDate {
  if (period === "D") return observationDaysBefore(asOf, barsAgo);
  const date = new Date(msOf(asOf));
  if (period === "W") return isoOf(msOf(asOf) - (((date.getUTCDay() + 6) % 7) + 7 * barsAgo) * DAY_MS);
  return isoOf(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - barsAgo, 1));
}

const ok = (body: unknown): Reply => ({ status: 200, body });
const fail = (status: number, code: ApiErrorCode, message: string, reason: ApiErrorReason | null = null): Reply => ({
  status,
  body: { error: { code, message, reason, retryAt: null, manualActionRequired: false } satisfies ApiErrorBody },
});

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
type BarCondition = Exclude<Condition, { kind: "market_cap" }>;
const isBarCondition = (c: Condition): c is BarCondition => c.kind !== "market_cap";

const matchChance = (c: Condition) => {
  if (c.kind === "new_high" || c.kind === "new_low") return Math.min(0.9, 0.3 + (4 * (c.barRange.end - c.barRange.start + 1)) / c.n);
  return isBarCondition(c) ? Math.min(0.9, 0.3 + 0.05 * (c.barRange.end - c.barRange.start + 1)) : 0.5;
};

function resultOf(screen: Screen, asOf: KstDate, historyDone: number): ScreenerResult {
  const excludedKinds = new Set(screen.exclude.flatMap((k) => EXCLUDED_KIND[k] ?? []));
  const universe = STOCKS.filter((s) => !excludedKinds.has(s.kind) && (screen.markets.length === 0 || screen.markets.includes(s.market)));
  const bars = screen.conditions.filter(isBarCondition);
  const records = bars.flatMap((c) => (c.kind === "new_high" || c.kind === "new_low" ? [c] : []));
  const neededDays = Math.max(0, ...records.map((c) => (c.n + c.barRange.end) * DAYS_PER_BAR[c.period]));
  const excluded = { listedTooShort: 0, historyShort: 0, unconfirmed: 0 };
  const rows: ScreenerRow[] = [];
  for (const s of universe) {
    if (records.some((c) => s.years * BARS_PER_YEAR[c.period] < c.n)) {
      excluded.listedTooShort++;
      continue;
    }
    if (STOCKS.indexOf(s) >= historyDone && neededDays > ONE_PAGE_DAYS) {
      excluded.historyShort++;
      continue;
    }
    const random = mulberry32(seedOf(`${s.code}:${asOf}:${JSON.stringify(screen.conditions)}`));
    const hits = screen.conditions.map((c) => (random() < matchChance(c) ? (isBarCondition(c) ? c.barRange.start + Math.floor(random() * (c.barRange.end - c.barRange.start + 1)) : 0) : null));
    if (hits.includes(null)) continue;
    const first = bars[0];
    const matchedDate = first ? barStart(first.period, asOf, hits[screen.conditions.indexOf(first)] ?? 0) : asOf;
    const changeRate = Math.round((random() - 0.35) * 1600) / 100;
    rows.push({ symbol: s.code, name: s.name, close: s.close, changeRate, matchedDate });
  }
  rows.sort((a, b) => (a.matchedDate === b.matchedDate ? (a.symbol < b.symbol ? -1 : 1) : a.matchedDate < b.matchedDate ? 1 : -1));
  return { asOf, universe: universe.length, excluded, rows };
}

interface Job {
  full: boolean;
  startedAt: number;
  target: KstDate;
  historyFrom: number;
  failAt: number | null;
}

export function createScreener(scenario: FakeScreenerScenario, clock: () => number = Date.now) {
  const total = STOCKS.length;
  const firstNeed = needDayAt(clock());
  let lastDay: KstDate | null = scenario === "empty" ? null : scenario === "ready" ? firstNeed : observationDaysBefore(firstNeed, BEHIND_DAYS);
  let historyDone = scenario === "empty" ? 0 : total;
  let failNext = scenario === "failing";
  let job: Job | null = null;
  let stopped: ScreenerUpdate | null = null;
  const recentEnd = SYMBOLS_PHASE_MS + total * RECENT_MS_PER_STOCK;

  function advance(now: number): ScreenerUpdate | null {
    if (!job) return stopped;
    const { full, startedAt, target, historyFrom, failAt } = job;
    const at = (phase: UpdatePhase, done: number): ScreenerUpdate => ({ phase, done, total: phase === "symbols" ? 1 : total, error: null, full });
    const elapsed = now - startedAt;
    if (elapsed < SYMBOLS_PHASE_MS) return at("symbols", 0);
    const recentDone = Math.min(total, Math.floor((elapsed - SYMBOLS_PHASE_MS) / RECENT_MS_PER_STOCK));
    if (failAt !== null && recentDone >= failAt) {
      job = null;
      stopped = { ...at("recent", failAt), error: KIWOOM_DOWN };
      return stopped;
    }
    if (recentDone < total) return at("recent", recentDone);
    lastDay = target;
    historyDone = Math.min(total, historyFrom + Math.floor((elapsed - recentEnd) / BACKFILL_MS_PER_STOCK));
    if (historyDone < total) return at("backfill", historyDone);
    job = null;
    return null;
  }

  function status(): ScreenerStatus {
    const now = clock();
    const update = advance(now);
    const todayAvailable = todayConfirmedAt(now) && (lastDay === null || lastDay < kstToday(now));
    return { lastDay, needDay: needDayAt(now), todayAvailable, fullHistory: { done: historyDone, total }, unconfirmed: 0, update };
  }

  return {
    status: (): Reply => ok(status()),
    start(body: unknown): Reply {
      if (!isObject(body) || typeof body.full !== "boolean") return fail(400, "bad_request", "본문은 { full: boolean }이어야 합니다");
      const now = clock();
      if (advance(now)?.error === null) return ok(status());
      stopped = null;
      job = {
        full: body.full,
        startedAt: now,
        target: todayConfirmedAt(now) ? kstToday(now) : needDayAt(now),
        historyFrom: body.full ? 0 : historyDone,
        failAt: failNext ? Math.floor(total * FAILING_SHARE) : null,
      };
      failNext = false;
      return ok(status());
    },
    cancel(): Reply {
      advance(clock());
      job = null;
      stopped = null;
      return ok(status());
    },
    run(body: unknown): Reply {
      if (!isScreen(body)) return fail(400, "bad_request", "조건식 본문이 아닙니다");
      const now = clock();
      const update = advance(now);
      if (update?.error === null && update.phase === "recent") return fail(409, "screener_not_ready", "최근 관측일을 채우는 중이라 실행할 수 없습니다", "updating");
      const needDay = needDayAt(now);
      if (lastDay === null || lastDay < needDay) return fail(409, "screener_not_ready", `저장소에 ${needDay} 자료가 없습니다. 업데이트하세요`, "missing_day");
      return ok(resultOf(body, lastDay, historyDone));
    },
  };
}
