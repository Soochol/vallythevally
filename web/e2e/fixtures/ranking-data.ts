import type { Request } from "@playwright/test";
import type { Broker } from "../../src/api/generated/Broker";
import type { RankingPage } from "../../src/api/generated/RankingPage";
import type { RankingRequest } from "../../src/api/generated/RankingRequest";
import type { RankingRow } from "../../src/api/generated/RankingRow";
import type { Scenario } from "./scenario";

const KNOWN: ReadonlyArray<readonly [string, string]> = [
  ["005930", "삼성전자"],
  ["000660", "SK하이닉스"],
  ["035420", "NAVER"],
  ["051910", "LG화학"],
  ["000270", "기아"],
];

export const UNLISTED_CODE = "900999";

export function tradeAmountRow(index: number, version = 0, listed = true): RankingRow {
  const [code, name] = KNOWN[index] ?? [String(100_000 + index), `종목 ${index + 1}`];
  return {
    rank: index + 1,
    code: listed ? code : UNLISTED_CODE,
    name: listed ? name : "상장 밖 종목",
    listed,
    price: 70_000 + index,
    changeRate: index % 2 === 0 ? 1.5 : -0.5,
    figures: { kind: "tradeAmount", tradeAmount: (1_000 - index + version) * 100_000_000, volume: 1_000_000 + index, placesGained: index % 3 === 0 ? 2 : index % 3 === 1 ? -1 : 0 },
  };
}

export const rankingRows = (count: number, version = 0): RankingRow[] => Array.from({ length: count }, (_, index) => tradeAmountRow(index, version));

export interface RankingServer {
  calls(): RankingRequest[];
  failNext(count?: number): void;
}

interface ServeOptions {
  rows?: (version: number) => RankingRow[];
  pageSize?: number;
  limited?: boolean;
  hidden?: number;
  source?: Broker;
}

export function serveRankings(scenario: Scenario, options: ServeOptions = {}): RankingServer {
  const rows = options.rows ?? ((version) => rankingRows(250, version));
  const pageSize = options.pageSize ?? 100;
  let version = 0;
  let failures = 0;
  scenario.on(isRankingRequest, (request) => {
    if (failures > 0) {
      failures--;
      return { status: 503, body: { error: { code: "kiwoom_unavailable", message: "키움이 응답하지 않습니다", reason: null, retryAt: null, manualActionRequired: false } } };
    }
    const asked: RankingRequest = request.postDataJSON();
    const all = rows(version);
    const shown = all.slice(0, asked.pages * pageSize);
    const end = shown.length >= all.length;
    const page: RankingPage = { rows: shown, pages: asked.pages, end, limited: !end && options.limited === true, hidden: options.hidden ?? 0, fetchedAt: Math.floor(scenario.now / 1000) + version, source: options.source ?? "kiwoom" };
    version++;
    return { body: page };
  });
  return {
    calls: () => rankingCalls(scenario),
    failNext: (count = 1) => { failures = count; },
  };
}

export function isRankingRequest(url: URL, request: Request): boolean {
  return url.pathname === "/api/rankings" && request.method() === "POST";
}

export const rankingCalls = (scenario: Scenario): RankingRequest[] => scenario.requests.filter((r) => new URL(r.url()).pathname === "/api/rankings" && r.method() === "POST").map((r) => r.postDataJSON());
