// dev 서버 전용 가짜 /api. vite.config.ts가 VITE_FAKE_API=0이 아닐 때만 붙인다(apply: "serve").
// 999999는 어디서나 unknown_symbol이다. 555555(조회실패시험)의 봉은 kiwoom_unavailable,
// 888888(상장폐지시험)은 검색에는 나오지만 봉은 unknown_symbol로 답한다(칸 오류 화면 확인용).
import type { ServerResponse } from "node:http";
import type { Plugin } from "vite";
import type { ApiError } from "../src/api/generated/ApiError.ts";
import type { ApiErrorCode } from "../src/api/generated/ApiErrorCode.ts";
import type { Period } from "../src/api/generated/Period.ts";
import { barsPage, findSymbol, publicInfo, search } from "./fakeMarket.ts";

const LATEST_PAGE_DELAY_MS = 800;
const PAST_PAGE_DELAY_MS = 400;
const PERIODS: Period[] = ["1m", "3m", "5m", "15m", "30m", "60m", "D", "W", "M"];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function send(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}
function fail(res: ServerResponse, status: number, code: ApiErrorCode, message: string) {
  const body: ApiError = { error: { code, message } };
  send(res, status, body);
}

export function fakeApi(): Plugin {
  return {
    name: "vv-fake-api",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/api", async (req, res) => {
        const url = new URL(req.url ?? "/", "http://fake");
        const path = url.pathname;
        if (path === "/symbols") return send(res, 200, search(url.searchParams.get("q") ?? ""));
        if (path.startsWith("/symbols/")) {
          const code = decodeURIComponent(path.slice("/symbols/".length));
          const s = findSymbol(code);
          if (!s) return fail(res, 404, "unknown_symbol", `종목 ${code}을 찾을 수 없습니다`);
          return send(res, 200, publicInfo(s));
        }
        if (path === "/bars") {
          const code = url.searchParams.get("symbol") ?? "";
          const period = url.searchParams.get("period") as Period;
          const before = url.searchParams.get("before");
          const limit = Number(url.searchParams.get("limit") ?? 500);
          if (!PERIODS.includes(period) || !(limit >= 1 && limit <= 1000)) {
            return fail(res, 400, "bad_request", "symbol, period, limit(1~1000)을 확인하세요");
          }
          await sleep(before === null ? LATEST_PAGE_DELAY_MS : PAST_PAGE_DELAY_MS);
          const s = findSymbol(code);
          if (!s) return fail(res, 404, "unknown_symbol", `종목 ${code}을 찾을 수 없습니다`);
          if (s.fail === "unknown_symbol") return fail(res, 404, "unknown_symbol", `종목 ${code}을 찾을 수 없습니다`);
          if (s.fail === "kiwoom_unavailable") {
            return fail(res, 503, "kiwoom_unavailable", "키움 조회가 응답하지 않습니다. 잠시 뒤 다시 시도하세요.");
          }
          return send(res, 200, barsPage(s, period, limit, before === null ? null : Number(before), Date.now()));
        }
        return fail(res, 404, "not_found", "없는 API 경로입니다");
      });
    },
  };
}
