import { expect, test } from "vitest";
import type { Screen } from "../../api/generated/Screen";
import type { ScreenerResult } from "../../api/generated/ScreenerResult";
import type { Screens } from "../../api/generated/Screens";
import { screenKey, type ScreenRun } from "../../stores/screener";
import { addCondition, changeKind, editCondition, placeCondition, removeCondition, toggleExclude, toggleMarket } from "../screen-dialog/screenForm";
import { createWorkspace, type PutOutcome, type ScreenRunner, type ScreensPort } from "./workspace";

const source: Screen = { id: "a", name: "신고가", markets: [], exclude: [], conditions: [{ kind: "new_high", period: "D", recentBars: 5, field: "high", n: 200 }] };
const base: Screens = { revision: 1, screens: [source] };
const result: ScreenerResult = { asOf: "2026-11-10", collectionStartedAt: 1, collectionCompletedAt: 2, missingSummary: 0, universe: 28, excluded: { listedTooShort: 0, historyShort: 28, unconfirmed: 0 }, rows: [] };
const many = (count: number) => Array.from({ length: count }, (_, index): Screen => ({ ...source, id: String(index) }));

function fakeServer(initial: Screens) {
  let stored = structuredClone(initial);
  let failure: string | null = null;
  let gate: Promise<void> | null = null;
  const puts: { screens: Screen[]; revision: number }[] = [];
  const outcomes: PutOutcome["kind"][] = [];
  const reject = (message: string): PutOutcome => ({ kind: "error", message });
  const answer = (screens: Screen[], revision: number): PutOutcome => {
    if (failure !== null) {
      const message = failure;
      failure = null;
      return reject(message);
    }
    if (screens.length > 50) return reject(`조건식은 50개까지 저장할 수 있습니다: ${screens.length}개`);
    const ids = new Set<string>();
    for (const screen of screens) {
      const length = [...screen.name.trim()].length;
      if (length < 1 || length > 40) return reject(`조건식 이름은 공백을 빼고 1~40자여야 합니다: ${JSON.stringify(screen.name)}`);
      if (ids.has(screen.id)) return reject(`조건식 id가 겹칩니다: ${screen.id}`);
      ids.add(screen.id);
    }
    if (revision <= stored.revision) return { kind: "stale", latest: structuredClone(stored) };
    stored = structuredClone({ screens, revision });
    return { kind: "ok", saved: structuredClone(stored) };
  };
  const port: ScreensPort = {
    load: async () => structuredClone(stored),
    put: async (screens, revision) => {
      puts.push(structuredClone({ screens, revision }));
      if (gate) await gate;
      const outcome = answer(screens, revision);
      outcomes.push(outcome.kind);
      return outcome;
    },
  };
  return {
    port,
    puts,
    outcomes,
    stored: () => stored,
    replace: (next: Screens) => { stored = structuredClone(next); },
    failNext: (message: string) => { failure = message; },
    pause: () => {
      let release = () => {};
      gate = new Promise((done) => { release = () => { gate = null; done(); }; });
      return release;
    },
  };
}

function fakeRunner() {
  let runs: Record<string, ScreenRun> = {};
  const sent: Screen[] = [];
  const runner: ScreenRunner = {
    runs: () => runs,
    run: async (screen) => {
      sent.push(structuredClone(screen));
      runs = { ...runs, [screen.id]: { kind: "done", screen, key: screenKey(screen), result, storeVersion: 0 } };
    },
  };
  return { runner, sent };
}

async function opened(initial: Screens = base, options: { desktop?: () => boolean } = {}) {
  const server = fakeServer(initial);
  const runs = fakeRunner();
  const workspace = createWorkspace({ screens: server.port, runner: runs.runner, showsDrafts: options.desktop });
  await workspace.load();
  const chosen = () => {
    const shown = workspace.view().chosen;
    if (!shown) throw new Error("고른 조건식이 있어야 합니다");
    return shown;
  };
  return { workspace, server, sent: runs.sent, chosen };
}

test("문장 변경은 저장본을 바꾸지 않고 시장·제외·순서·삭제를 유지한다", async () => {
  const { workspace, server, chosen } = await opened();
  workspace.edit((d) => toggleExclude(toggleMarket(d, "kospi"), "etf"));
  workspace.edit(addCondition);
  const second = chosen().draft!.conditions.at(-1)!;
  workspace.edit((d) => changeKind(d, second.key, "rsi"));
  workspace.edit((d) => placeCondition(d, second.key, d.conditions[0]!.key));
  expect(chosen().draft!.conditions.map((line) => line.kind)).toEqual(["rsi", "new_high"]);
  workspace.edit((d) => removeCondition(d, second.key));
  const runnable = chosen().runnable;
  expect(runnable.ok && runnable.screen).toEqual({ ...source, markets: ["kospi"], exclude: ["etf"] });
  expect(chosen().dirty).toBe(true);
  expect(chosen().source).toEqual(source);
  expect(server.puts).toEqual([]);
  expect(source.markets).toEqual([]);
});

test("잘못된 최근 기간은 저장하지 않고 초안과 검증 메시지를 보존한다", async () => {
  const { workspace, server, chosen } = await opened();
  workspace.edit((d) => editCondition(d, { ...d.conditions[0]!, recentBars: "0" }));
  await workspace.save();
  expect(chosen().runnable.ok).toBe(false);
  expect(chosen().tried).toBe(true);
  expect(chosen().draft!.conditions[0]!.recentBars).toBe("0");
  expect(server.puts).toEqual([]);
});

test("저장 충돌은 초안을 보존하고 문구를 띄우며, 다시 저장하면 최신 목록의 다른 식을 지키며 덮어쓴다", async () => {
  const { workspace, server, chosen } = await opened();
  const other: Screen = { ...source, id: "b", name: "다른 식" };
  server.replace({ revision: 3, screens: [source, other] });
  workspace.edit((d) => ({ ...d, name: "수정한 식" }));
  await workspace.save();
  expect(server.outcomes).toEqual(["stale"]);
  expect(chosen().notice).toBe("다른 탭이나 기기에서 조건식 목록이 바뀌어 덮어쓰지 않았습니다. 변경 내용은 유지했습니다. 다시 저장하면 최신 목록에 반영합니다.");
  expect(chosen().draft!.name).toBe("수정한 식");
  expect(chosen().dirty).toBe(true);
  await workspace.save();
  expect(server.puts.at(-1)).toEqual({ revision: 4, screens: [{ ...source, name: "수정한 식" }, other] });
  expect(server.outcomes).toEqual(["stale", "ok"]);
  expect(chosen().dirty).toBe(false);
  expect(chosen().saving).toBe(false);
  expect(chosen().notice).toBeNull();
});

test("저장 도중에는 추가 편집과 중복 저장을 막고, 실패 뒤 다시 저장한다", async () => {
  const { workspace, server, chosen } = await opened();
  workspace.edit((d) => ({ ...d, name: "바꿈" }));
  const release = server.pause();
  server.failNext("쓰기 실패");
  const pending = workspace.save();
  expect(chosen().saving).toBe(true);
  workspace.edit((d) => ({ ...d, name: "저장 중 입력" }));
  await workspace.save();
  expect(server.puts).toHaveLength(1);
  expect(chosen().draft!.name).toBe("바꿈");
  release();
  await pending;
  expect(chosen().saving).toBe(false);
  expect(chosen().notice).toBe("저장하지 못했습니다: 쓰기 실패");
  await workspace.save();
  expect(chosen().dirty).toBe(false);
  expect(server.stored().screens).toEqual([{ ...source, name: "바꿈" }]);
});

test("개수 제한은 나중에 알게 된 최신 목록으로 검사하고, 요청 없이 막아도 초안의 충돌 기준은 그대로다", async () => {
  const older: Screens = { revision: 1, screens: many(49) };
  const { workspace, server, chosen } = await opened(older);
  workspace.create();
  server.replace({ revision: 2, screens: many(50) });
  await workspace.load();
  const runnable = chosen().runnable;
  expect(!runnable.ok && runnable.errors.list).toContain("조건식은 50개까지");
  await workspace.save();
  expect(server.puts).toEqual([]);
  expect(chosen().tried).toBe(true);
  server.replace({ revision: 3, screens: many(49) });
  await workspace.load();
  await workspace.save();
  expect(server.puts.map((sent) => [sent.revision, sent.screens.length])).toEqual([[2, 50]]);
  expect(server.outcomes).toEqual(["stale"]);
});

test("삭제 충돌·실패는 초안을 보존하고 다시 시도하면 지운다", async () => {
  const { workspace, server, chosen } = await opened();
  server.replace({ ...base, revision: 3 });
  workspace.edit((d) => ({ ...d, name: "보존" }));
  expect(await workspace.remove()).toBe(false);
  expect(chosen().draft!.name).toBe("보존");
  expect(chosen().notice).toBe("다른 탭이나 기기에서 조건식 목록이 바뀌어 삭제하지 않았습니다. 바뀐 목록을 불러왔으니 다시 삭제하세요.");
  server.failNext("삭제 실패");
  expect(await workspace.remove()).toBe(false);
  expect(chosen().draft!.name).toBe("보존");
  expect(chosen().notice).toBe("삭제하지 못했습니다: 삭제 실패");
  expect(await workspace.remove()).toBe(true);
  expect(server.outcomes).toEqual(["stale", "error", "ok"]);
  expect(server.stored().screens).toEqual([]);
  expect(workspace.view()).toEqual({ entries: [], chosen: null });
});

test("저장하지 않은 초안 B를 지우면 요청 없이 사라지고, 남은 초안 A를 고르며 A의 편집은 남는다", async () => {
  const { workspace, server, chosen } = await opened({ revision: 0, screens: [] });
  const a = workspace.create()!;
  workspace.edit((d) => ({ ...d, name: "남겨 둘 A" }));
  const b = workspace.create()!;
  expect(chosen().source.id).toBe(b);
  expect(await workspace.remove()).toBe(true);
  expect(server.puts).toEqual([]);
  expect(workspace.view().entries.map((entry) => entry.source.id)).toEqual([a]);
  expect(chosen().source.id).toBe(a);
  workspace.choose("");
  expect(chosen().source.id).toBe(a);
  expect(chosen().draft!.name).toBe("남겨 둘 A");
});

test("저장한 식을 지우면 남은 목록의 첫 식을 고른다", async () => {
  const second: Screen = { ...source, id: "b", name: "둘째" };
  const { workspace, chosen } = await opened({ revision: 1, screens: [source, second] });
  workspace.choose(source.id);
  expect(await workspace.remove()).toBe(true);
  expect(chosen().source).toEqual(second);
});

test("50개가 찬 목록에서 하나를 지우면 새 초안을 저장할 수 있고, 서버 검사를 거쳐 50개로 저장한다", async () => {
  const full: Screens = { revision: 1, screens: many(50) };
  const { workspace, server, chosen } = await opened(full);
  const id = workspace.create()!;
  expect(chosen().runnable.ok).toBe(false);
  workspace.choose("0");
  expect(await workspace.remove()).toBe(true);
  expect(chosen().source.id).toBe("1");
  workspace.choose(id);
  expect(chosen().runnable.ok).toBe(true);
  await workspace.save();
  await workspace.save();
  expect(server.puts.map((sent) => sent.screens.length)).toEqual([49, 50, 50]);
  expect(server.puts.map((sent) => sent.revision)).toEqual([2, 2, 3]);
  expect(server.outcomes).toEqual(["ok", "stale", "ok"]);
  expect(server.stored().screens).toHaveLength(50);
  expect(server.stored().screens.some((screen) => screen.id === "0")).toBe(false);
  expect(server.stored().screens.some((screen) => screen.id === id)).toBe(true);
  expect(chosen().dirty).toBe(false);
});

test("새 조건식과 복제는 서로 다른 ID로 남고, 다른 식을 골라도 편집이 사라지지 않는다", async () => {
  const { workspace, chosen } = await opened();
  const id = workspace.create()!;
  expect(chosen().draft!.conditions).toEqual([]);
  expect(chosen().dirty).toBe(true);
  workspace.edit((d) => ({ ...d, name: "나의 조건" }));
  const copyId = workspace.create(true)!;
  expect(copyId).not.toBe(id);
  expect(chosen().source.id).toBe(copyId);
  expect(chosen().draft!.name).toBe("나의 조건 복사");
  workspace.choose(source.id);
  workspace.choose(id);
  expect(chosen().draft!.name).toBe("나의 조건");
  expect(workspace.view().entries.map((entry) => [entry.source.id, entry.draft?.name])).toEqual([[source.id, source.name], [id, "나의 조건"], [copyId, "나의 조건 복사"]]);
});

test("다른 탭에서 목록이 바뀌어도 편집 중인 초안과 충돌 기준 revision은 그대로다", async () => {
  const { workspace, server, chosen } = await opened();
  workspace.edit((d) => ({ ...d, name: "수정 중" }));
  server.replace({ revision: 4, screens: [{ ...source, name: "다른 탭", markets: ["kospi"] }] });
  await workspace.load();
  workspace.edit((d) => toggleMarket(d, "kosdaq"));
  expect(chosen().draft!.name).toBe("수정 중");
  expect(chosen().draft!.markets).toEqual(["kosdaq"]);
  await workspace.save();
  expect(server.puts.map((sent) => sent.revision)).toEqual([2]);
  expect(server.outcomes).toEqual(["stale"]);
});

test("고치지 않은 조건식은 최신 저장본을 보이고, 다음 편집도 그 값과 revision에서 시작한다", async () => {
  const { workspace, server, chosen } = await opened();
  workspace.edit((d) => ({ ...d, name: "로컬 저장" }));
  await workspace.save();
  const remote: Screen = { ...source, name: "다른 탭 저장", markets: ["kospi"] };
  server.replace({ revision: 3, screens: [remote] });
  await workspace.load();
  expect(chosen().draft!.name).toBe(remote.name);
  expect(chosen().draft!.markets).toEqual(remote.markets);
  expect(chosen().dirty).toBe(false);
  workspace.edit((d) => toggleExclude(d, "etf"));
  expect(chosen().draft).toMatchObject({ name: remote.name, markets: ["kospi"], exclude: ["etf"] });
  await workspace.save();
  expect(server.puts.at(-1)).toEqual({ revision: 4, screens: [{ ...remote, exclude: ["etf"] }] });
  expect(server.outcomes).toEqual(["ok", "ok"]);
});

test("최신 목록에서 지운 식은 고치지 않았으면 사라지고, 고치던 중이면 원래 revision의 초안으로 남는다", async () => {
  const clean = await opened();
  clean.workspace.edit((d) => d);
  clean.server.replace({ revision: 2, screens: [] });
  await clean.workspace.load();
  expect(clean.workspace.view()).toEqual({ entries: [], chosen: null });

  const { workspace, server, chosen } = await opened();
  workspace.edit((d) => ({ ...d, name: "보존할 편집" }));
  server.replace({ revision: 2, screens: [] });
  await workspace.load();
  workspace.choose("");
  expect(chosen().source.id).toBe(source.id);
  expect(chosen().draft!.name).toBe("보존할 편집");
  await workspace.save();
  expect(server.puts.map((sent) => sent.revision)).toEqual([2]);
  expect(server.outcomes).toEqual(["stale"]);
});

for (const operation of ["save", "remove"] as const) {
  test(`${operation}은 최신으로 알려진 목록 위에 합성해 다른 식을 지키고, 원래 revision 충돌 뒤 다시 시도한다`, async () => {
    const { workspace, server } = await opened();
    workspace.edit((d) => ({ ...d, name: "내 변경" }));
    const other: Screen = { ...source, id: "b", name: "다른 탭의 식", markets: ["kosdaq"] };
    server.replace({ revision: 3, screens: [source, other] });
    await workspace.load();
    workspace.choose(source.id);
    await workspace[operation]();
    expect(server.puts[0]?.revision).toBe(2);
    expect(server.puts[0]?.screens.find((screen) => screen.id === "b")).toEqual(other);
    expect(server.outcomes).toEqual(["stale"]);
    await workspace[operation]();
    expect(server.outcomes).toEqual(["stale", "ok"]);
    expect(server.stored().screens.find((screen) => screen.id === "b")).toEqual(other);
    expect(server.stored().screens.find((screen) => screen.id === source.id)?.name).toBe(operation === "save" ? "내 변경" : undefined);
  });
}

test("실행은 저장 전 초안을 그대로 보내고, 잘못된 값이면 보내지 않고 오류를 보인다", async () => {
  const { workspace, sent, chosen } = await opened();
  workspace.edit((d) => ({ ...toggleMarket(d, "kosdaq"), name: "지금 편집 중" }));
  expect(await workspace.run(false)).toBe("ran");
  expect(sent).toEqual([{ ...source, name: "지금 편집 중", markets: ["kosdaq"] }]);
  expect(chosen().run?.kind).toBe("done");
  expect(chosen().dirty).toBe(true);
  expect(source.name).toBe("신고가");
  workspace.edit((d) => ({ ...d, name: "" }));
  expect(chosen().tried).toBe(false);
  expect(await workspace.run(false)).toBe("invalid");
  expect(sent).toHaveLength(1);
  expect(chosen().tried).toBe(true);
  expect(chosen().nameError).toBe("이름을 넣으세요");
  expect(chosen().run).toBeNull();
});

test("자료 상태가 막혀 있거나 조건식이 없으면 실행하지 않는다", async () => {
  const { workspace, sent } = await opened();
  expect(await workspace.run(true)).toBe("blocked");
  const empty = await opened({ revision: 0, screens: [] });
  expect(await empty.workspace.run(false)).toBe("none");
  expect([...sent, ...empty.sent]).toEqual([]);
});

test("실행 결과는 그 결과를 낸 조건식에만 붙고, 같은 내용으로 되돌리면 다시 보인다", async () => {
  const { workspace, chosen } = await opened();
  await workspace.run(false);
  expect(chosen().run?.kind).toBe("done");
  workspace.edit((d) => toggleMarket(d, "kospi"));
  expect(chosen().run).toBeNull();
  workspace.edit((d) => toggleMarket(d, "kospi"));
  expect(chosen().run?.kind).toBe("done");
});

test("저장한 뒤 다른 탭이 고친 저장본을 실행한다", async () => {
  const { workspace, server, sent } = await opened();
  workspace.edit((d) => ({ ...d, name: "로컬 저장" }));
  await workspace.save();
  const remote: Screen = { ...source, name: "다른 탭 저장", markets: ["kosdaq"] };
  server.replace({ revision: 3, screens: [remote] });
  await workspace.load();
  await workspace.run(false);
  expect(sent).toEqual([remote]);
});

test("휴대폰 폭에서는 조건식 초안을 보이지 않고 저장본을 실행하지만, 초안은 지우지 않는다", async () => {
  let desktop = true;
  const stored: Screen = { conditions: [{ n: 200, field: "high", recentBars: 5, period: "D", kind: "new_high" }], exclude: [], markets: [], name: "신고가", id: "a" };
  const { workspace, sent, chosen } = await opened({ revision: 1, screens: [stored] }, { desktop: () => desktop });
  await workspace.run(false);
  workspace.edit((d) => ({ ...d, name: "고치는 중" }));
  const added = workspace.create()!;
  desktop = false;
  expect(workspace.view().entries).toEqual([{ source: stored }]);
  expect(chosen()).toMatchObject({ source: stored, dirty: false, runnable: { ok: true, screen: stored } });
  expect(chosen().draft).toBeUndefined();
  expect(chosen().run?.kind).toBe("done");
  expect(await workspace.run(false)).toBe("ran");
  desktop = true;
  expect(chosen().source.id).toBe(added);
  workspace.choose(stored.id);
  expect(chosen().draft!.name).toBe("고치는 중");
  expect(sent).toEqual([source, stored]);
});

test("같은 조건식을 실행하는 중이면 다시 보내지 않는다", async () => {
  const sent: Screen[] = [];
  const running: ScreenRun = { kind: "running", screen: source, key: screenKey(source), shown: null };
  const workspace = createWorkspace({ screens: fakeServer(base).port, runner: { runs: () => ({ [source.id]: running }), run: async (screen) => { sent.push(screen); } } });
  await workspace.load();
  expect(await workspace.run(false)).toBe("busy");
  workspace.edit((d) => toggleMarket(d, "kospi"));
  expect(await workspace.run(false)).toBe("ran");
  expect(sent).toEqual([{ ...source, markets: ["kospi"] }]);
});
