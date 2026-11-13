import { QueryClient } from "@tanstack/react-query";
import { afterEach, expect, test, vi } from "vitest";
import type { Screen } from "../../api/generated/Screen";
import type { Screens } from "../../api/generated/Screens";
import { screensQuery } from "../../api/screener";
import { queryScreens, screenEditingFor } from "./useScreenEditing";

const source: Screen = { id: "a", name: "신고가", markets: [], exclude: [], conditions: [] };
const quietClient = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

afterEach(() => vi.unstubAllGlobals());

test("react-query의 조건식 목록이 바뀌면 조건식 편집이 그 목록을 보인다", () => {
  const client = quietClient();
  client.setQueryData(screensQuery.queryKey, { revision: 1, screens: [source] } satisfies Screens);
  const editing = screenEditingFor(client);
  expect(editing.view().chosen?.source).toEqual(source);
  const renamed: Screen = { ...source, name: "다른 탭에서 고침" };
  client.setQueryData(screensQuery.queryKey, { revision: 2, screens: [renamed] } satisfies Screens);
  expect(editing.view().entries.map((entry) => entry.name)).toEqual(["다른 탭에서 고침"]);
  expect(screenEditingFor(client)).toBe(editing);
});

test("목록 읽기와 저장 요청이 던지면 오류 결과가 된다", async () => {
  const port = queryScreens(quietClient());
  vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("연결 끊김"); }));
  expect(await port.load()).toMatchObject({ kind: "error" });
  expect(await port.put([source], 1)).toMatchObject({ kind: "error" });
});

test("충돌 뒤 최신 목록을 다시 읽지 못하면 저장 결과는 오류다", async () => {
  const sent: unknown[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === "PUT") {
      sent.push(JSON.parse(String(init.body)));
      return reply({ error: { code: "stale_revision", message: "목록 바뀜" } }, 409);
    }
    return reply({ error: { code: "internal", message: "목록 읽기 실패" } }, 500);
  }));
  expect(await queryScreens(quietClient()).put([source], 1)).toEqual({ kind: "error", message: "목록 읽기 실패" });
  expect(sent).toEqual([{ screens: [source], revision: 2 }]);
});
