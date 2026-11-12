import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Screen } from "../../api/generated/Screen";
import type { Screens } from "../../api/generated/Screens";
import { screensQuery } from "../../api/screener";
import { useScreenerStore } from "../../stores/screener";
import { DEFAULT_SEARCH_COMMANDS } from "../search/commands";
import { addCondition, changeKind, editCondition, placeCondition, removeCondition, toggleExclude, toggleMarket } from "../screen-dialog/screenForm";
import { availableSources, checkedSession, currentSession, isDirty, selectedSource, useScreenEditor } from "./editorState";

const source: Screen = { id: "a", name: "신고가", markets: [], exclude: [], conditions: [{ kind: "new_high", period: "D", recentBars: 5, field: "high", n: 200 }] };
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
  const checked = checkedSession(current(), base);
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

test("잘못된 최근 기간는 저장하지 않고 draft와 검증 메시지를 보존한다", async () => {
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  editor().change(base, source, (d) => editCondition(d, { ...d.conditions[0]!, recentBars: "0" }));
  await editor().save(client, base, source);
  expect(checkedSession(current(), base).ok).toBe(false);
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

test("saved clean session uses latest remotely saved values when running", async () => {
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => reply(JSON.parse(String(init.body)))));
  editor().change(base, source, (draft) => ({ ...draft, name: "로컬 저장" }));
  await editor().save(client, base, source);
  expect(isDirty(current())).toBe(false);
  const remote: Screen = { ...source, name: "다른 탭 저장", markets: ["kosdaq"] };
  const latest: Screens = { revision: 3, screens: [remote] };
  client.setQueryData(screensQuery.queryKey, latest);
  vi.stubGlobal("matchMedia", () => ({ matches: true }));
  const requests: Screen[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    if (url === "/api/screens") return reply(latest);
    if (url === "/api/screener/status") return reply({ lastDay: "2026-11-10", needDay: "2026-11-10", update: null, fullHistory: { done: 1, total: 1 } });
    requests.push(JSON.parse(String(init.body)));
    return reply({ rows: [] });
  }));
  await DEFAULT_SEARCH_COMMANDS.find((command) => command.id === "screener-run")!.run({ queryClient: client, slot: 0 });
  expect(requests).toEqual([remote]);
});

test("new draft recovers after freeing a slot from a full saved list", async () => {
  const full: Screens = { revision: 1, screens: Array.from({ length: 50 }, (_, index) => ({ ...source, id: String(index) })) };
  const id = editor().create(full);
  const added = editor().sessions[id]!.source;
  expect(checkedSession(editor().sessions[id]!, full).ok).toBe(false);
  const fetch = vi.fn(async (_url: string, init: RequestInit) => reply(JSON.parse(String(init.body))));
  vi.stubGlobal("fetch", fetch);
  expect(await editor().remove(client, full, full.screens[0]!)).toBe(true);
  const latest = client.getQueryData(screensQuery.queryKey)!;
  expect(latest.screens).toHaveLength(49);
  expect(checkedSession(editor().sessions[id]!, latest).ok).toBe(true);
  await editor().save(client, latest, added);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(isDirty(editor().sessions[id]!)).toBe(false);
});

test("미저장 식 B를 지워도 남은 A가 기본 선택에 포함된다", async () => {
  const empty: Screens = { revision: 0, screens: [] };
  const a = editor().create(empty);
  const b = editor().create(empty);
  const added = editor().sessions[b]!.source;
  editor().change(empty, editor().sessions[a]!.source, (draft) => ({ ...draft, name: "남겨 둘 A" }));
  expect(await editor().remove(client, empty, added)).toBe(true);
  expect(availableSources(empty, editor().sessions).map((screen) => screen.id)).toEqual([a]);
  expect(selectedSource(empty, null, editor().sessions)?.id).toBe(a);
  useScreenerStore.getState().choose("");
  expect(selectedSource(empty, useScreenerStore.getState().chosenId, editor().sessions)?.id).toBe(a);
  expect(editor().sessions[a]?.draft.name).toBe("남겨 둘 A");
});

test("다른 탭에서 목록이 바뀌어도 편집 중 draft와 충돌 기준 revision은 보존한다", () => {
  editor().change(base, source, (draft) => ({ ...draft, name: "수정 중" }));
  const latest: Screens = { revision: 4, screens: [{ ...source, name: "다른 탭", markets: ["kospi"] }] };
  editor().change(latest, latest.screens[0]!, (draft) => toggleMarket(draft, "kosdaq"));
  expect(current().draft.name).toBe("수정 중");
  expect(current().draft.markets).toEqual(["kosdaq"]);
  expect(current().base.revision).toBe(1);
  expect(current().source).toEqual(source);
});

test("깨끗한 세션은 최신 저장본을 표시하고 다음 편집도 그 값과 revision에서 시작한다", async () => {
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => reply(JSON.parse(String(init.body)))));
  editor().change(base, source, (draft) => ({ ...draft, name: "로컬 저장" }));
  await editor().save(client, base, source);
  const remote: Screen = { ...source, name: "다른 탭 저장", markets: ["kospi"] };
  const latest: Screens = { revision: 3, screens: [remote] };
  const shown = currentSession(latest, remote, editor().sessions);
  expect(shown.draft.name).toBe(remote.name);
  expect(shown.draft.markets).toEqual(remote.markets);
  expect(shown.base.revision).toBe(3);
  expect(isDirty(shown)).toBe(false);
  editor().change(latest, remote, (draft) => toggleExclude(draft, "etf"));
  expect(current().draft.markets).toEqual(["kospi"]);
  expect(current().draft.name).toBe(remote.name);
  expect(current().draft.exclude).toEqual(["etf"]);
  expect(current().base.revision).toBe(3);
});

test("최신 목록에서 지운 식은 깨끗하면 사라지고 편집 중이면 draft로 남는다", () => {
  editor().change(base, source, (draft) => draft);
  const empty: Screens = { revision: 2, screens: [] };
  expect(selectedSource(empty, source.id, editor().sessions)).toBeNull();
  editor().change(base, source, (draft) => ({ ...draft, name: "보존할 편집" }));
  expect(selectedSource(empty, null, editor().sessions)?.id).toBe(source.id);
  expect(currentSession(empty, source, editor().sessions).draft.name).toBe("보존할 편집");
  expect(current().base.revision).toBe(1);
});

test("개수 제한은 최신 목록을 검사하되 새 draft의 충돌 기준은 바꾸지 않는다", async () => {
  const older: Screens = { revision: 1, screens: Array.from({ length: 49 }, (_, index) => ({ ...source, id: String(index) })) };
  const id = editor().create(older);
  const session = editor().sessions[id]!;
  const latest: Screens = { revision: 2, screens: [...older.screens, { ...source, id: "49" }] };
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  const checked = checkedSession(session, latest);
  expect(!checked.ok && checked.errors.list).toContain("조건식은 50개까지");
  await editor().save(client, latest, session.source);
  expect(fetch).not.toHaveBeenCalled();
  expect(editor().sessions[id]?.base.revision).toBe(1);
});
