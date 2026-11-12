import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Screen } from "../../api/generated/Screen";
import type { Screens } from "../../api/generated/Screens";
import { screensQuery } from "../../api/screener";
import { useScreenerStore } from "../../stores/screener";
import { DEFAULT_SEARCH_COMMANDS } from "../search/commands";
import { addCondition, changeKind, editCondition, placeCondition, removeCondition, toggleExclude, toggleMarket } from "../screen-dialog/screenForm";
import { checkedSession, isDirty, selectedSource, useScreenEditor } from "./editorState";

const source: Screen = { id: "a", name: "신고가", markets: [], exclude: [], conditions: [{ kind: "new_high", period: "D", barRange: { start: 0, end: 4 }, field: "high", n: 200 }] };
const base: Screens = { revision: 1, screens: [source] };
let client: QueryClient;
const editor = () => useScreenEditor.getState();
const current = () => editor().sessions[source.id]!;
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  useScreenEditor.setState({ sessions: {} });
  useScreenerStore.setState({ chosenId: source.id, runs: {} });
});
afterEach(() => { client.clear(); vi.unstubAllGlobals(); });

test("문장 변경은 저장본을 바꾸지 않고 시장·제외·순서·삭제를 유지한다", () => {
  editor().change(base, source, (d) => toggleExclude(toggleMarket(d, "kospi"), "etf"));
  editor().change(base, source, addCondition);
  const second = current().draft.conditions.at(-1)!;
  editor().change(base, source, (d) => changeKind(d, second.key, "rsi"));
  editor().change(base, source, (d) => placeCondition(d, second.key, d.conditions[0]!.key));
  expect(current().draft.conditions.map((line) => line.kind)).toEqual(["rsi", "new_high"]);
  editor().change(base, source, (d) => removeCondition(d, second.key));
  const checked = checkedSession(current());
  expect(checked.ok && checked.screen).toEqual({ ...source, markets: ["kospi"], exclude: ["etf"] });
  expect(isDirty(current())).toBe(true);
  expect(base.screens).toEqual([source]);
  expect(source.markets).toEqual([]);
  expect(selectedSource(base, source.id, editor().sessions)).toEqual(source);
});

test("새 조건식과 복제는 서로 다른 ID로 남고, 다른 식을 골라도 편집이 사라지지 않는다", () => {
  const id = editor().create(base);
  const session = editor().sessions[id]!;
  expect(session.draft.conditions).toEqual([]);
  expect(isDirty(session)).toBe(true);
  const copyId = editor().create(base, { ...session.draft, name: "나의 조건" });
  expect(copyId).not.toBe(id);
  expect(editor().sessions[copyId]?.draft.name).toBe("나의 조건 복사");
  expect(selectedSource(base, id, editor().sessions)?.id).toBe(id);
});

test("드래그 순서 변경은 양방향·자기 자신·없는 행을 안전하게 처리한다", () => {
  let draft = addCondition(addCondition(addCondition({ name: "a", markets: [], exclude: [], conditions: [] })));
  draft = placeCondition(draft, 0, 2);
  expect(draft.conditions.map((c) => c.key)).toEqual([1, 2, 0]);
  draft = placeCondition(draft, 0, 1);
  expect(draft.conditions.map((c) => c.key)).toEqual([0, 1, 2]);
  expect(placeCondition(draft, 0, 0)).toBe(draft);
  expect(placeCondition(draft, 9, 0)).toBe(draft);
});

test("잘못된 봉 범위는 저장하지 않고 draft와 검증 메시지를 보존한다", async () => {
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  editor().change(base, source, (d) => editCondition(d, { ...d.conditions[0]!, rangeStart: "5", rangeEnd: "2" }));
  await editor().save(client, base, source);
  expect(checkedSession(current()).ok).toBe(false);
  expect(current().tried).toBe(true);
  expect(fetch).not.toHaveBeenCalled();
});

test("저장 충돌은 최신 목록만 바꾸고 draft를 보존하며 재시도는 다른 식을 보존한다", async () => {
  const other: Screen = { ...source, id: "b", name: "다른 식" };
  const latest: Screens = { revision: 3, screens: [source, other] };
  const puts: Screens[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
    if (init.method !== "PUT") return reply(latest);
    const sent: Screens = JSON.parse(String(init.body)); puts.push(sent);
    return sent.revision <= latest.revision ? reply({ error: { code: "stale_revision", message: "목록 바뀜" } }, 409) : reply(sent);
  }));
  editor().change(base, source, (d) => ({ ...d, name: "수정한 식" }));
  await editor().save(client, base, source);
  expect(current().saving.kind).toBe("failed");
  expect(current().draft.name).toBe("수정한 식");
  expect(current().base).toEqual(latest);
  await editor().save(client, base, source);
  expect(puts.at(-1)).toEqual({ revision: 4, screens: [{ ...source, name: "수정한 식" }, other] });
  expect(isDirty(current())).toBe(false);
  expect(current().saving.kind).toBe("idle");
});

test("저장 도중에는 추가 편집과 중복 저장을 막고 실패 후 다시 저장한다", async () => {
  let finish: ((response: Response) => void) | undefined;
  const fetch = vi.fn(() => new Promise<Response>((resolve) => { finish = resolve; })); vi.stubGlobal("fetch", fetch);
  editor().change(base, source, (d) => ({ ...d, name: "바꿈" }));
  const pending = editor().save(client, base, source);
  editor().change(base, source, (d) => ({ ...d, name: "저장 중 입력" }));
  await editor().save(client, base, source);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(current().draft.name).toBe("바꿈");
  finish?.(reply({ error: { code: "internal", message: "쓰기 실패" } }, 500)); await pending;
  expect(current().saving.kind).toBe("failed");
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => reply(JSON.parse(String(init.body)))));
  await editor().save(client, base, source);
  expect(isDirty(current())).toBe(false);
});

test("삭제 충돌·실패는 편집을 보존하고 재시도로 삭제한다", async () => {
  const latest = { ...base, revision: 3 };
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => init.method === "PUT" ? reply({ error: { code: "stale_revision", message: "목록 바뀜" } }, 409) : reply(latest)));
  editor().change(base, source, (d) => ({ ...d, name: "보존" }));
  expect(await editor().remove(client, base, source)).toBe(false);
  expect(current().draft.name).toBe("보존");
  vi.stubGlobal("fetch", vi.fn(async () => reply({ error: { code: "internal", message: "삭제 실패" } }, 500)));
  expect(await editor().remove(client, base, source)).toBe(false);
  expect(current().draft.name).toBe("보존");
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => reply(JSON.parse(String(init.body)))));
  expect(await editor().remove(client, base, source)).toBe(true);
  expect(editor().sessions[source.id]).toBeUndefined();
});

test("Ctrl+Enter 명령은 저장 전 draft를 실행하고 잘못된 값은 실행하지 않는다", async () => {
  const bodies: Screen[] = [];
  client.setQueryData(screensQuery.queryKey, base);
  vi.stubGlobal("matchMedia", () => ({ matches: true }));
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    if (url === "/api/screens") return reply(base);
    if (url === "/api/screener/status") return reply({ lastDay: "2026-11-10", needDay: "2026-11-10", update: null, fullHistory: { done: 1, total: 1 } });
    bodies.push(JSON.parse(String(init.body)));
    return reply({ rows: [] });
  }));
  editor().change(base, source, (d) => toggleMarket(d, "kosdaq"));
  const command = DEFAULT_SEARCH_COMMANDS.find((c) => c.id === "screener-run")!;
  await command.run({ queryClient: client, slot: 0 });
  expect(bodies).toEqual([{ ...source, markets: ["kosdaq"] }]);
  expect(isDirty(current())).toBe(true);
  editor().change(base, source, (d) => ({ ...d, name: "" }));
  await command.run({ queryClient: client, slot: 0 });
  expect(bodies).toHaveLength(1);
  expect(current().tried).toBe(true);
});
