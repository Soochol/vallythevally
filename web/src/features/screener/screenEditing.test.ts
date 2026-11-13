import { expect, test } from "vitest";
import type { Screen } from "../../api/generated/Screen";
import type { ScreenerResult } from "../../api/generated/ScreenerResult";
import type { Screens } from "../../api/generated/Screens";
import { ApiRequestError } from "../../api/http";
import { screenKey, type ScreenRun, shownResult } from "../../stores/screener";
import { addCondition, changeKind, editCondition, placeCondition, removeCondition, toggleExclude, toggleMarket } from "../screen-dialog/screenForm";
import { createScreenEditing, type PutOutcome, type RunCheck, type ScreenRunner, type ScreensPort } from "./screenEditing";

const source: Screen = { id: "a", name: "신고가", markets: [], exclude: [], conditions: [{ kind: "new_high", period: "D", recentBars: 5, field: "high", n: 200 }] };
const base: Screens = { revision: 1, screens: [source] };
const result: ScreenerResult = { asOf: "2026-11-10", collectionStartedAt: 1, collectionCompletedAt: 2, missingSummary: 0, universe: 28, excluded: { listedTooShort: 0, historyShort: 28, unconfirmed: 0 }, rows: [] };
const many = (count: number) => Array.from({ length: count }, (_, index): Screen => ({ ...source, id: String(index) }));

function fakeServer(initial: Screens) {
  let stored = structuredClone(initial);
  let failure: string | null = null;
  let loadFailure: string | null = null;
  let gate: Promise<void> | null = null;
  let seen = (_list: Screens) => {};
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
    watch: (see) => { seen = see; },
    load: async () => {
      if (loadFailure === null) return { kind: "ok", list: structuredClone(stored) };
      const message = loadFailure;
      loadFailure = null;
      return { kind: "error", message };
    },
    put: async (screens, since) => {
      const revision = since + 1;
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
    publish: () => seen(structuredClone(stored)),
    failNext: (message: string) => { failure = message; },
    failLoad: (message: string) => { loadFailure = message; },
    pause: () => {
      let release = () => {};
      gate = new Promise((done) => { release = () => { gate = null; done(); }; });
      return release;
    },
  };
}

function fakeRunner() {
  let runs: Record<string, ScreenRun> = {};
  let failure: { reject: boolean; message: string } | null = null;
  const sent: Screen[] = [];
  const control = { check: { kind: "ready" } as RunCheck };
  const runner: ScreenRunner = {
    runs: () => runs,
    check: async () => control.check,
    run: async (screen) => {
      sent.push(structuredClone(screen));
      const key = screenKey(screen);
      const next = failure;
      failure = null;
      if (next?.reject) throw new Error(next.message);
      runs = { ...runs, [screen.id]: next ? { kind: "failed", screen, key, shown: null, error: new ApiRequestError("internal", next.message) } : { kind: "done", screen, key, result, storeVersion: 0 } };
    },
  };
  return {
    runner,
    sent,
    control,
    failRun: (message: string) => { failure = { reject: false, message }; },
    rejectRun: (message: string) => { failure = { reject: true, message }; },
  };
}

function opened(initial: Screens = base, options: { desktop?: () => boolean; publish?: boolean } = {}) {
  const server = fakeServer(initial);
  const runner = fakeRunner();
  const editing = createScreenEditing({ screens: server.port, runner: runner.runner, showsDrafts: options.desktop });
  if (options.publish !== false) server.publish();
  const chosen = () => {
    const shown = editing.view().chosen;
    if (!shown) throw new Error("고른 조건식이 있어야 합니다");
    return shown;
  };
  const edited = () => {
    const shown = chosen();
    if (!shown.draft) throw new Error("조건식 초안이 보여야 합니다");
    return shown;
  };
  return { editing, server, runner, sent: runner.sent, chosen, edited };
}

test("문장 변경은 저장본을 바꾸지 않고 시장·제외·순서·삭제를 유지한다", async () => {
  const { editing, server, chosen, edited } = opened();
  editing.edit((d) => toggleExclude(toggleMarket(d, "kospi"), "etf"));
  editing.edit(addCondition);
  const second = edited().draft.conditions.at(-1)!;
  editing.edit((d) => changeKind(d, second.key, "rsi"));
  editing.edit((d) => placeCondition(d, second.key, d.conditions[0]!.key));
  expect(edited().draft.conditions.map((line) => line.kind)).toEqual(["rsi", "new_high"]);
  editing.edit((d) => removeCondition(d, second.key));
  const runnable = chosen().runnable;
  expect(runnable.ok && runnable.screen).toEqual({ ...source, markets: ["kospi"], exclude: ["etf"] });
  expect(chosen().dirty).toBe(true);
  expect(chosen().source).toEqual(source);
  expect(server.puts).toEqual([]);
  expect(source.markets).toEqual([]);
});

test("잘못된 최근 기간은 저장하지 않고 초안과 검증 메시지를 보존한다", async () => {
  const { editing, server, chosen, edited } = opened();
  editing.edit((d) => editCondition(d, { ...d.conditions[0]!, recentBars: "0" }));
  await editing.save();
  expect(chosen().runnable.ok).toBe(false);
  expect(chosen().tried).toBe(true);
  expect(edited().draft.conditions[0]!.recentBars).toBe("0");
  expect(server.puts).toEqual([]);
});

test("저장 충돌은 초안을 보존하고 문구를 띄우며, 다시 저장하면 최신 목록의 다른 식을 지키며 덮어쓴다", async () => {
  const { editing, server, chosen, edited } = opened();
  const other: Screen = { ...source, id: "b", name: "다른 식" };
  server.replace({ revision: 3, screens: [source, other] });
  editing.edit((d) => ({ ...d, name: "수정한 식" }));
  await editing.save();
  expect(server.outcomes).toEqual(["stale"]);
  expect(chosen().notice).toBe("다른 탭이나 기기에서 조건식 목록이 바뀌어 덮어쓰지 않았습니다. 변경 내용은 유지했습니다. 다시 저장하면 최신 목록에 반영합니다.");
  expect(edited().draft.name).toBe("수정한 식");
  expect(chosen().dirty).toBe(true);
  await editing.save();
  expect(server.puts.at(-1)).toEqual({ revision: 4, screens: [{ ...source, name: "수정한 식" }, other] });
  expect(server.outcomes).toEqual(["stale", "ok"]);
  expect(chosen().dirty).toBe(false);
  expect(chosen().saving).toBe(false);
  expect(chosen().notice).toBeNull();
});

test("저장 도중에는 추가 편집과 중복 저장을 막고, 실패 뒤 다시 저장한다", async () => {
  const { editing, server, chosen, edited } = opened();
  editing.edit((d) => ({ ...d, name: "바꿈" }));
  const release = server.pause();
  server.failNext("쓰기 실패");
  const pending = editing.save();
  expect(chosen().saving).toBe(true);
  editing.edit((d) => ({ ...d, name: "저장 중 입력" }));
  await editing.save();
  expect(server.puts).toHaveLength(1);
  expect(edited().draft.name).toBe("바꿈");
  release();
  await pending;
  expect(chosen().saving).toBe(false);
  expect(chosen().notice).toBe("저장하지 못했습니다: 쓰기 실패");
  await editing.save();
  expect(chosen().dirty).toBe(false);
  expect(server.stored().screens).toEqual([{ ...source, name: "바꿈" }]);
});

test("개수 제한은 나중에 알게 된 최신 목록으로 검사하고, 요청 없이 막아도 초안의 충돌 기준은 그대로다", async () => {
  const older: Screens = { revision: 1, screens: many(49) };
  const { editing, server, chosen } = opened(older);
  editing.create();
  server.replace({ revision: 2, screens: many(50) });
  server.publish();
  const runnable = chosen().runnable;
  expect(!runnable.ok && runnable.errors.list).toContain("조건식은 50개까지");
  await editing.save();
  expect(server.puts).toEqual([]);
  expect(chosen().tried).toBe(true);
  server.replace({ revision: 3, screens: many(49) });
  server.publish();
  await editing.save();
  expect(server.puts.map((sent) => [sent.revision, sent.screens.length])).toEqual([[2, 50]]);
  expect(server.outcomes).toEqual(["stale"]);
});

test("삭제 충돌·실패는 초안을 보존하고 다시 시도하면 지운다", async () => {
  const { editing, server, chosen, edited } = opened();
  server.replace({ ...base, revision: 3 });
  editing.edit((d) => ({ ...d, name: "보존" }));
  expect(await editing.remove()).toBe(false);
  expect(edited().draft.name).toBe("보존");
  expect(chosen().notice).toBe("다른 탭이나 기기에서 조건식 목록이 바뀌어 삭제하지 않았습니다. 바뀐 목록을 불러왔으니 다시 삭제하세요.");
  server.failNext("삭제 실패");
  expect(await editing.remove()).toBe(false);
  expect(edited().draft.name).toBe("보존");
  expect(chosen().notice).toBe("삭제하지 못했습니다: 삭제 실패");
  expect(await editing.remove()).toBe(true);
  expect(server.outcomes).toEqual(["stale", "error", "ok"]);
  expect(server.stored().screens).toEqual([]);
  expect(editing.view()).toEqual({ entries: [], chosen: null });
});

test("저장하지 않은 초안 B를 지우면 요청 없이 사라지고, 남은 초안 A를 고르며 A의 편집은 남는다", async () => {
  const { editing, server, chosen, edited } = opened({ revision: 0, screens: [] });
  editing.create();
  const a = chosen().source.id;
  editing.edit((d) => ({ ...d, name: "남겨 둘 A" }));
  editing.create();
  const b = chosen().source.id;
  expect(chosen().source.id).toBe(b);
  expect(await editing.remove()).toBe(true);
  expect(server.puts).toEqual([]);
  expect(editing.view().entries.map((entry) => entry.source.id)).toEqual([a]);
  expect(chosen().source.id).toBe(a);
  editing.choose("");
  expect(chosen().source.id).toBe(a);
  expect(edited().draft.name).toBe("남겨 둘 A");
});

test("저장한 식을 지우면 남은 목록의 첫 식을 고른다", async () => {
  const second: Screen = { ...source, id: "b", name: "둘째" };
  const { editing, chosen } = opened({ revision: 1, screens: [source, second] });
  editing.choose(source.id);
  expect(await editing.remove()).toBe(true);
  expect(chosen().source).toEqual(second);
});

test("50개가 찬 목록에서 하나를 지우면 새 초안을 저장할 수 있고, 서버 검사를 거쳐 50개로 저장한다", async () => {
  const full: Screens = { revision: 1, screens: many(50) };
  const { editing, server, chosen } = opened(full);
  editing.create();
  const id = chosen().source.id;
  expect(chosen().runnable.ok).toBe(false);
  editing.choose("0");
  expect(await editing.remove()).toBe(true);
  expect(chosen().source.id).toBe("1");
  editing.choose(id);
  expect(chosen().runnable.ok).toBe(true);
  await editing.save();
  await editing.save();
  expect(server.puts.map((sent) => sent.screens.length)).toEqual([49, 50, 50]);
  expect(server.puts.map((sent) => sent.revision)).toEqual([2, 2, 3]);
  expect(server.outcomes).toEqual(["ok", "stale", "ok"]);
  expect(server.stored().screens).toHaveLength(50);
  expect(server.stored().screens.some((screen) => screen.id === "0")).toBe(false);
  expect(server.stored().screens.some((screen) => screen.id === id)).toBe(true);
  expect(chosen().dirty).toBe(false);
});

test("새 조건식과 복제는 서로 다른 ID로 남고, 다른 식을 골라도 편집이 사라지지 않는다", async () => {
  const { editing, chosen, edited } = opened();
  editing.create();
  const id = chosen().source.id;
  expect(edited().draft.conditions).toEqual([]);
  expect(chosen().dirty).toBe(true);
  editing.edit((d) => ({ ...d, name: "나의 조건" }));
  editing.create(true);
  const copyId = chosen().source.id;
  expect(copyId).not.toBe(id);
  expect(chosen().source.id).toBe(copyId);
  expect(edited().draft.name).toBe("나의 조건 복사");
  editing.choose(source.id);
  editing.choose(id);
  expect(edited().draft.name).toBe("나의 조건");
  expect(editing.view().entries.map((entry) => [entry.source.id, entry.name])).toEqual([[source.id, source.name], [id, "나의 조건"], [copyId, "나의 조건 복사"]]);
});

test("다른 탭에서 목록이 바뀌어도 편집 중인 초안과 충돌 기준 revision은 그대로다", async () => {
  const { editing, server, edited } = opened();
  editing.edit((d) => ({ ...d, name: "수정 중" }));
  server.replace({ revision: 4, screens: [{ ...source, name: "다른 탭", markets: ["kospi"] }] });
  server.publish();
  editing.edit((d) => toggleMarket(d, "kosdaq"));
  expect(edited().draft.name).toBe("수정 중");
  expect(edited().draft.markets).toEqual(["kosdaq"]);
  await editing.save();
  expect(server.puts.map((sent) => sent.revision)).toEqual([2]);
  expect(server.outcomes).toEqual(["stale"]);
});

test("고치지 않은 조건식은 최신 저장본을 보이고, 다음 편집도 그 값과 revision에서 시작한다", async () => {
  const { editing, server, chosen, edited } = opened();
  editing.edit((d) => ({ ...d, name: "로컬 저장" }));
  await editing.save();
  const remote: Screen = { ...source, name: "다른 탭 저장", markets: ["kospi"] };
  server.replace({ revision: 3, screens: [remote] });
  server.publish();
  expect(edited().draft.name).toBe(remote.name);
  expect(edited().draft.markets).toEqual(remote.markets);
  expect(chosen().dirty).toBe(false);
  editing.edit((d) => toggleExclude(d, "etf"));
  expect(chosen().draft).toMatchObject({ name: remote.name, markets: ["kospi"], exclude: ["etf"] });
  await editing.save();
  expect(server.puts.at(-1)).toEqual({ revision: 4, screens: [{ ...remote, exclude: ["etf"] }] });
  expect(server.outcomes).toEqual(["ok", "ok"]);
});

test("최신 목록에서 지운 식은 고치지 않았으면 사라지고, 고치던 중이면 원래 revision의 초안으로 남는다", async () => {
  const clean = opened();
  clean.editing.edit((d) => d);
  clean.server.replace({ revision: 2, screens: [] });
  clean.server.publish();
  expect(clean.editing.view()).toEqual({ entries: [], chosen: null });

  const { editing, server, chosen, edited } = opened();
  editing.edit((d) => ({ ...d, name: "보존할 편집" }));
  server.replace({ revision: 2, screens: [] });
  server.publish();
  editing.choose("");
  expect(chosen().source.id).toBe(source.id);
  expect(edited().draft.name).toBe("보존할 편집");
  await editing.save();
  expect(server.puts.map((sent) => sent.revision)).toEqual([2]);
  expect(server.outcomes).toEqual(["stale"]);
});

for (const operation of ["save", "remove"] as const) {
  test(`${operation}은 최신으로 알려진 목록 위에 합성해 다른 식을 지키고, 원래 revision 충돌 뒤 다시 시도한다`, async () => {
    const { editing, server } = opened();
    editing.edit((d) => ({ ...d, name: "내 변경" }));
    const other: Screen = { ...source, id: "b", name: "다른 탭의 식", markets: ["kosdaq"] };
    server.replace({ revision: 3, screens: [source, other] });
    server.publish();
    editing.choose(source.id);
    await editing[operation]();
    expect(server.puts[0]?.revision).toBe(2);
    expect(server.puts[0]?.screens.find((screen) => screen.id === "b")).toEqual(other);
    expect(server.outcomes).toEqual(["stale"]);
    await editing[operation]();
    expect(server.outcomes).toEqual(["stale", "ok"]);
    expect(server.stored().screens.find((screen) => screen.id === "b")).toEqual(other);
    expect(server.stored().screens.find((screen) => screen.id === source.id)?.name).toBe(operation === "save" ? "내 변경" : undefined);
  });
}

test("실행은 저장 전 초안을 그대로 보내고, 잘못된 값이면 보내지 않고 오류를 보인다", async () => {
  const { editing, sent, chosen } = opened();
  editing.edit((d) => ({ ...toggleMarket(d, "kosdaq"), name: "지금 편집 중" }));
  expect(await editing.run()).toEqual({ kind: "ran" });
  expect(sent).toEqual([{ ...source, name: "지금 편집 중", markets: ["kosdaq"] }]);
  expect(chosen().run?.kind).toBe("done");
  expect(chosen().dirty).toBe(true);
  expect(source.name).toBe("신고가");
  editing.edit((d) => ({ ...d, name: "" }));
  expect(chosen().tried).toBe(false);
  expect(await editing.run()).toEqual({ kind: "invalid" });
  expect(sent).toHaveLength(1);
  expect(chosen().tried).toBe(true);
  expect(chosen().nameError).toBe("이름을 넣으세요");
  expect(chosen().run).toBeNull();
});

test("자료 상태가 막혀 있거나 조건식이 없으면 실행하지 않는다", async () => {
  const { editing, sent, runner } = opened();
  runner.control.check = { kind: "blocked" };
  expect(await editing.run()).toEqual({ kind: "blocked" });
  const empty = opened({ revision: 0, screens: [] });
  expect(await empty.editing.run()).toEqual({ kind: "none" });
  expect([...sent, ...empty.sent]).toEqual([]);
});

test("실행 결과는 그 결과를 낸 조건식에만 붙고, 같은 내용으로 되돌리면 다시 보인다", async () => {
  const { editing, chosen } = opened();
  await editing.run();
  expect(chosen().run?.kind).toBe("done");
  editing.edit((d) => toggleMarket(d, "kospi"));
  expect(chosen().run).toBeNull();
  editing.edit((d) => toggleMarket(d, "kospi"));
  expect(chosen().run?.kind).toBe("done");
});

test("저장한 뒤 다른 탭이 고친 저장본을 실행한다", async () => {
  const { editing, server, sent } = opened();
  editing.edit((d) => ({ ...d, name: "로컬 저장" }));
  await editing.save();
  const remote: Screen = { ...source, name: "다른 탭 저장", markets: ["kosdaq"] };
  server.replace({ revision: 3, screens: [remote] });
  server.publish();
  await editing.run();
  expect(sent).toEqual([remote]);
});

test("휴대폰 폭에서는 조건식 초안을 보이지 않고 저장본을 실행하지만, 초안은 지우지 않는다", async () => {
  let desktop = true;
  const stored: Screen = { conditions: [{ n: 200, field: "high", recentBars: 5, period: "D", kind: "new_high" }], exclude: [], markets: [], name: "신고가", id: "a" };
  const { editing, sent, chosen, edited } = opened({ revision: 1, screens: [stored] }, { desktop: () => desktop });
  await editing.run();
  editing.edit((d) => ({ ...d, name: "고치는 중" }));
  editing.create();
  const added = chosen().source.id;
  desktop = false;
  expect(editing.view().entries).toEqual([{ source: stored, name: "신고가", conditions: 1 }]);
  expect(chosen()).toMatchObject({ source: stored, dirty: false, runnable: { ok: true, screen: stored } });
  expect(chosen().draft).toBeUndefined();
  expect(chosen().run?.kind).toBe("done");
  expect(await editing.run()).toEqual({ kind: "ran" });
  desktop = true;
  expect(chosen().source.id).toBe(added);
  editing.choose(stored.id);
  expect(edited().draft.name).toBe("고치는 중");
  expect(sent).toEqual([source, stored]);
});

test("같은 조건식을 실행하는 중이면 다시 보내지 않는다", async () => {
  const sent: Screen[] = [];
  const running: ScreenRun = { kind: "running", screen: source, key: screenKey(source), shown: null };
  const server = fakeServer(base);
  const editing = createScreenEditing({ screens: server.port, runner: { runs: () => ({ [source.id]: running }), check: async () => ({ kind: "ready" }), run: async (screen) => { sent.push(screen); } } });
  server.publish();
  expect(await editing.run()).toEqual({ kind: "busy" });
  editing.edit((d) => toggleMarket(d, "kospi"));
  expect(await editing.run()).toEqual({ kind: "ran" });
  expect(sent).toEqual([{ ...source, markets: ["kospi"] }]);
});

test("자료 상태를 확인하지 못하면 실패를 알리고 보내지 않는다", async () => {
  const { editing, sent, runner } = opened();
  runner.control.check = { kind: "error", message: "상태 읽기 실패" };
  expect(await editing.run()).toEqual({ kind: "failed", message: "상태 읽기 실패" });
  expect(sent).toEqual([]);
});

test("처음 목록을 불러오지 못하면 고른 조건식 없이 실패를 알리고, 다시 불러오면 실행한다", async () => {
  const { editing, server, sent } = opened(base, { publish: false });
  server.failLoad("목록 읽기 실패");
  expect(await editing.run()).toEqual({ kind: "failed", message: "목록 읽기 실패" });
  expect(editing.view()).toEqual({ entries: [], chosen: null });
  expect(sent).toEqual([]);
  expect(await editing.run()).toEqual({ kind: "ran" });
  expect(sent).toEqual([source]);
});

test("충돌 저장 뒤 목록을 다시 불러오지 못해도 초안과 충돌 문구가 남고, 다시 저장하면 덮어쓴다", async () => {
  const { editing, server, sent, chosen, edited } = opened();
  editing.edit((d) => ({ ...d, name: "수정한 식" }));
  server.replace({ revision: 3, screens: [source] });
  await editing.save();
  server.failLoad("목록 읽기 실패");
  expect(await editing.run()).toEqual({ kind: "failed", message: "목록 읽기 실패" });
  expect(sent).toEqual([]);
  expect(edited().draft.name).toBe("수정한 식");
  expect(chosen().notice).toBe("다른 탭이나 기기에서 조건식 목록이 바뀌어 덮어쓰지 않았습니다. 변경 내용은 유지했습니다. 다시 저장하면 최신 목록에 반영합니다.");
  await editing.save();
  expect(server.outcomes).toEqual(["stale", "ok"]);
  expect(server.stored().screens).toEqual([{ ...source, name: "수정한 식" }]);
});

test("처음 실행이 실패하면 결과 없는 실패로 보이고, 다시 실행할 수 있다", async () => {
  const { editing, runner, chosen } = opened();
  runner.failRun("자료 변경");
  expect(await editing.run()).toEqual({ kind: "ran" });
  expect(chosen().run?.kind).toBe("failed");
  expect(shownResult(chosen().run)).toBeNull();
  expect(await editing.run()).toEqual({ kind: "ran" });
  expect(chosen().run?.kind).toBe("done");
});

test("처음 실행이 거부되면 실패를 알리고 결과 없이 남는다", async () => {
  const { editing, runner, chosen } = opened();
  runner.rejectRun("연결 끊김");
  expect(await editing.run()).toEqual({ kind: "failed", message: "연결 끊김" });
  expect(chosen().run).toBeNull();
});

test("성공한 뒤의 실행이 거부되면 실패를 알리고 앞의 결과를 그대로 보인다", async () => {
  const { editing, runner, chosen } = opened();
  await editing.run();
  runner.rejectRun("연결 끊김");
  expect(await editing.run()).toEqual({ kind: "failed", message: "연결 끊김" });
  expect(chosen().run?.kind).toBe("done");
  expect(shownResult(chosen().run)).toEqual(result);
});
