import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ApiRequestError } from "../api/http";
import { createSaver, type Saver, type SaveState, type SaverOptions, type Unsaved } from "./saver";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

type Value = { n: number; pad?: string };
type Send = SaverOptions<Value>["send"];

function setup({ send: sendImpl, revision = 100 }: { send?: Send; revision?: number } = {}) {
  let value: Value = { n: 0 };
  const sent: { json: string; keepalive: boolean }[] = [];
  const states: SaveState["kind"][] = [];
  let last: SaveState = { kind: "idle" };
  let unsaved: Unsaved | null = null;
  const send = vi.fn<Send>(async (path, json, opts) => {
    sent.push({ json, keepalive: opts.keepalive });
    return sendImpl?.(path, json, opts);
  });
  const saver = createSaver<Value>({
    debounceMs: 1000,
    read: () => value,
    tooLarge: (v) => (v.pad?.length ?? 0) > 10,
    path: () => "/x",
    revision,
    send,
    unsaved: {
      write: (u) => (unsaved = u),
      clear: (upTo) => {
        if (unsaved && unsaved.revision <= upTo) unsaved = null;
      },
    },
    onState: (s) => {
      last = s;
      states.push(s.kind);
    },
    now: () => 42,
  });
  const edit = (v: Value) => {
    value = v;
    saver.changed();
  };
  const ns = () => sent.map((s) => (JSON.parse(s.json) as Value).n);
  const revisions = () => sent.map((s) => (JSON.parse(s.json) as { revision: number }).revision);
  return { saver, edit, send, sent, ns, revisions, states, state: () => last, unsaved: () => unsaved };
}

test("마지막 편집 1초 뒤 최신 값을 한 번 보낸다", async () => {
  const t = setup();
  t.edit({ n: 1 });
  await vi.advanceTimersByTimeAsync(600);
  t.edit({ n: 2 });
  await vi.advanceTimersByTimeAsync(999);
  expect(t.send).not.toHaveBeenCalled();
  expect(t.state()).toEqual({ kind: "pending" });
  await vi.advanceTimersByTimeAsync(1);
  expect(t.ns()).toEqual([2]);
  expect(t.sent[0]!.keepalive).toBe(false);
  expect(t.state()).toEqual({ kind: "saved", at: 42 });
  expect(t.states).toEqual(["pending", "pending", "saving", "saved"]);
});

test("보내는 동안 들어온 편집은 응답 뒤 디바운스를 거쳐 다음 요청에 실린다", async () => {
  let resolve!: () => void;
  const t = setup({ send: () => new Promise<void>((r) => (resolve = r)) });
  t.edit({ n: 1 });
  await vi.advanceTimersByTimeAsync(1000);
  expect(t.state()).toEqual({ kind: "saving" });
  t.edit({ n: 2 });
  await vi.advanceTimersByTimeAsync(5000);
  expect(t.send).toHaveBeenCalledOnce();
  resolve();
  await vi.advanceTimersByTimeAsync(0);
  expect(t.state()).toEqual({ kind: "pending" });
  await vi.advanceTimersByTimeAsync(1000);
  expect(t.send).toHaveBeenCalledTimes(2);
  expect(t.ns()).toEqual([1, 2]);
});

test("실패하면 5초·15초·60초 뒤 다시 보내고, 그 뒤에는 다시 시도 버튼을 기다린다", async () => {
  const t = setup({ send: () => Promise.reject(new ApiRequestError("network", "서버에 연결하지 못했습니다")) });
  t.edit({ n: 1 });
  await vi.advanceTimersByTimeAsync(1000);
  expect(t.send).toHaveBeenCalledTimes(1);
  expect(t.state()).toEqual({ kind: "failed", reason: "error", message: "서버에 연결하지 못했습니다" });
  await vi.advanceTimersByTimeAsync(4999);
  expect(t.send).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(t.send).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(15000);
  expect(t.send).toHaveBeenCalledTimes(3);
  await vi.advanceTimersByTimeAsync(60000);
  expect(t.send).toHaveBeenCalledTimes(4);
  await vi.advanceTimersByTimeAsync(10 * 60_000);
  expect(t.send).toHaveBeenCalledTimes(4);

  t.saver.retry();
  await vi.advanceTimersByTimeAsync(0);
  expect(t.send).toHaveBeenCalledTimes(5);
  await vi.advanceTimersByTimeAsync(5000);
  expect(t.send).toHaveBeenCalledTimes(6);
});

test("다시 보내서 성공하면 저장됨이 된다", async () => {
  const send = vi.fn<Send>().mockRejectedValueOnce(new ApiRequestError("internal", "x")).mockResolvedValue(undefined);
  const t = setup({ send });
  t.edit({ n: 1 });
  await vi.advanceTimersByTimeAsync(6000);
  expect(send).toHaveBeenCalledTimes(2);
  expect(t.state()).toEqual({ kind: "saved", at: 42 });
});

test("413이면 다시 보내지 않는다", async () => {
  const t = setup({ send: () => Promise.reject(new ApiRequestError("payload_too_large", "64KB를 넘습니다")) });
  t.edit({ n: 1 });
  await vi.advanceTimersByTimeAsync(1000);
  expect(t.state()).toEqual({ kind: "failed", reason: "too_large" });
  await vi.advanceTimersByTimeAsync(10 * 60_000);
  expect(t.send).toHaveBeenCalledOnce();
});

test("미리 잰 값이 너무 크면 보내지 않고, 줄인 뒤 다음 편집에 보낸다", async () => {
  const t = setup();
  t.edit({ n: 1, pad: "x".repeat(11) });
  await vi.advanceTimersByTimeAsync(1000);
  expect(t.send).not.toHaveBeenCalled();
  expect(t.state()).toEqual({ kind: "failed", reason: "too_large" });
  await vi.advanceTimersByTimeAsync(10 * 60_000);
  expect(t.send).not.toHaveBeenCalled();
  t.edit({ n: 2 });
  await vi.advanceTimersByTimeAsync(1000);
  expect(t.ns()).toEqual([2]);
});

test("화면이 스스로 줄일 수 있으면 줄여서 한 번 보낸다", async () => {
  let value: { n: number; pad?: string } = { n: 1, pad: "x".repeat(11) };
  const shrink = vi.fn(() => {
    if (!value.pad) return false;
    value = { n: value.n };
    saver.changed(); // 줄인 것도 편집이다(스토어 구독이 부른다)
    return true;
  });
  const send = vi.fn<Send>(async () => {});
  const saver = createSaver<Value>({
    debounceMs: 1000,
    read: () => value,
    tooLarge: (v) => (v.pad?.length ?? 0) > 10,
    shrink,
    path: () => "/x",
    revision: 0,
    send,
    onState: () => {},
  });
  saver.changed();
  await vi.advanceTimersByTimeAsync(5000);
  expect(shrink).toHaveBeenCalledOnce();
  expect(send).toHaveBeenCalledOnce();
  expect(JSON.parse(send.mock.calls[0]![1])).toMatchObject({ n: 1 });
});

test("탭이 숨으면 기다리던 편집을 keepalive로 곧바로 보낸다", async () => {
  const t = setup();
  t.edit({ n: 1 });
  t.saver.flush();
  await vi.advanceTimersByTimeAsync(0);
  expect(t.ns()).toEqual([1]);
  expect(t.sent[0]!.keepalive).toBe(true);
  await vi.advanceTimersByTimeAsync(5000);
  expect(t.send).toHaveBeenCalledOnce();
});

test("보낼 편집이 없으면 숨어도 보내지 않는다", async () => {
  const t = setup();
  t.saver.flush();
  t.edit({ n: 1 });
  await vi.advanceTimersByTimeAsync(1000);
  t.saver.flush();
  await vi.advanceTimersByTimeAsync(0);
  expect(t.send).toHaveBeenCalledOnce();
});

test("보낼 때마다 revision이 늘어난다. 처음 것도 복원이 읽은 revision보다 크다", async () => {
  const t = setup({ revision: 100 });
  t.edit({ n: 1 });
  await vi.advanceTimersByTimeAsync(1000);
  t.edit({ n: 2 });
  await vi.advanceTimersByTimeAsync(1000);
  const [a, b] = t.revisions();
  expect(a).toBeGreaterThan(100);
  expect(b).toBeGreaterThan(a!);
});

test("R2: 앞 저장이 진행 중일 때 탭이 숨으면 최신 편집을 곧바로 keepalive로 보낸다", async () => {
  const pending: (() => void)[] = [];
  const t = setup({ send: () => new Promise<void>((r) => pending.push(r)) });
  t.edit({ n: 1 });
  await vi.advanceTimersByTimeAsync(1000);
  t.edit({ n: 2 });
  t.saver.flush();
  await vi.advanceTimersByTimeAsync(0);
  expect(t.ns()).toEqual([1, 2]);
  expect(t.sent[1]!.keepalive).toBe(true);
  const [first, second] = t.revisions();
  expect(second).toBeGreaterThan(first!);
  pending[1]!();
  await vi.advanceTimersByTimeAsync(0);
  pending[0]!();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(t.state()).toEqual({ kind: "saved", at: 42 });
  expect(t.send).toHaveBeenCalledTimes(2);
});

test("R2: 미저장 본문은 편집 즉시 남고, 서버가 받았을 때만 지워진다", async () => {
  const pending: ((ok: boolean) => void)[] = [];
  const t = setup({
    send: () => new Promise<void>((resolve, reject) => pending.push((ok) => (ok ? resolve() : reject(new ApiRequestError("network", "x"))))),
  });
  t.edit({ n: 1 });
  expect(JSON.parse(t.unsaved()!.body)).toMatchObject({ n: 1 });
  await vi.advanceTimersByTimeAsync(1000);
  t.edit({ n: 2 });
  expect(JSON.parse(t.unsaved()!.body)).toMatchObject({ n: 2 });
  pending[0]!(true);
  await vi.advanceTimersByTimeAsync(0);
  expect(JSON.parse(t.unsaved()!.body)).toMatchObject({ n: 2 });
  await vi.advanceTimersByTimeAsync(1000);
  pending[1]!(false);
  await vi.advanceTimersByTimeAsync(0);
  expect(t.unsaved()).not.toBeNull();
  await vi.advanceTimersByTimeAsync(5000);
  pending[2]!(true);
  await vi.advanceTimersByTimeAsync(0);
  expect(t.unsaved()).toBeNull();
  expect(t.state()).toEqual({ kind: "saved", at: 42 });
});

test("R2: stale_revision은 서버에 더 새 편집이 있다는 뜻이다. 실패로 보이지 않고 다시 보내지 않는다", async () => {
  const t = setup({ send: () => Promise.reject(new ApiRequestError("stale_revision", "더 새 편집")) });
  t.edit({ n: 1 });
  await vi.advanceTimersByTimeAsync(1000);
  expect(t.state()).toEqual({ kind: "saved", at: 42 });
  expect(t.unsaved()).toBeNull();
  await vi.advanceTimersByTimeAsync(10 * 60_000);
  expect(t.send).toHaveBeenCalledOnce();
});

test("R2: 나중 요청이 실패해도 같은 편집을 담은 앞 요청이 성공하면 저장됨이다", async () => {
  const pending: ((ok: boolean) => void)[] = [];
  const t = setup({
    send: () => new Promise<void>((resolve, reject) => pending.push((ok) => (ok ? resolve() : reject(new ApiRequestError("network", "x"))))),
  });
  t.edit({ n: 1 });
  await vi.advanceTimersByTimeAsync(1000);
  t.saver.flush(); // 앞 요청과 같은 편집을 keepalive로 한 번 더(탭 전환)
  await vi.advanceTimersByTimeAsync(0);
  expect(t.send).toHaveBeenCalledTimes(2);
  pending[1]!(false);
  await vi.advanceTimersByTimeAsync(0);
  pending[0]!(true);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(t.state()).toEqual({ kind: "saved", at: 42 });
  expect(t.send).toHaveBeenCalledTimes(2);
});

type Conditions = Parameters<Saver<Value>["commitConditional"]>[0];
type Latest = Awaited<ReturnType<Conditions["read"]>>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
const isConditional = (json: string) => (JSON.parse(json) as Value).n === 99;
const latestOf = (revision: number): Latest => ({ value: { n: 5 }, revision });

function conditions(overrides: Partial<Conditions> = {}) {
  return {
    read: vi.fn<Conditions["read"]>(async () => latestOf(500)),
    next: vi.fn<Conditions["next"]>(() => ({ n: 99 })),
    still: vi.fn<Conditions["still"]>(() => true),
    accept: vi.fn<Conditions["accept"]>(),
    ...overrides,
  };
}

test("조건부 저장은 최신 revision+1로 보내고 미저장 본문을 쓰고 지운 뒤 저장됨이 된다", async () => {
  const put = deferred<void>();
  const t = setup({ send: (_, json) => isConditional(json) ? put.promise : Promise.resolve() });
  const c = conditions();
  const result = t.saver.commitConditional(c);
  await vi.advanceTimersByTimeAsync(0);
  expect(c.next).toHaveBeenCalledWith({ n: 5 }, { kind: "idle" });
  expect(t.sent.map((s) => JSON.parse(s.json))).toEqual([{ n: 99, revision: 501 }]);
  expect(t.sent[0]!.keepalive).toBe(false);
  expect(t.unsaved()).toEqual({ path: "/x", revision: 501, body: JSON.stringify({ n: 99, revision: 501 }) });
  expect(t.state()).toEqual({ kind: "saving" });
  put.resolve();
  expect(await result).toBe("committed");
  expect(c.accept).toHaveBeenCalledWith({ n: 99, revision: 501 });
  expect(t.unsaved()).toBeNull();
  expect(t.state()).toEqual({ kind: "saved", at: 42 });
  expect(t.states).toEqual(["saving", "saved"]);
});

test("조건부 저장이 stale_revision이면 최신본을 다시 읽어 그 revision+1로 다시 보낸다", async () => {
  let puts = 0;
  const t = setup({ send: async (_, json) => { if (isConditional(json) && puts++ === 0) throw new ApiRequestError("stale_revision", "경쟁 저장"); } });
  const c = conditions({ read: vi.fn<Conditions["read"]>().mockResolvedValueOnce(latestOf(500)).mockResolvedValueOnce({ value: { n: 7 }, revision: 510 }) });
  expect(await t.saver.commitConditional(c)).toBe("committed");
  expect(c.read).toHaveBeenCalledTimes(2);
  expect(c.next).toHaveBeenLastCalledWith({ n: 7 }, { kind: "idle" });
  expect(t.revisions()).toEqual([501, 511]);
  expect(c.accept).toHaveBeenCalledWith({ n: 99, revision: 511 });
  expect(t.unsaved()).toBeNull();
});

test("조건부 저장이 세 번 경쟁에 지면 conflict이고 이전 상태로 돌아간 뒤 편집을 다시 저장한다", async () => {
  const t = setup({ send: async (_, json) => { if (isConditional(json)) throw new ApiRequestError("stale_revision", "경쟁 저장"); } });
  const c = conditions();
  expect(await t.saver.commitConditional(c)).toBe("conflict");
  expect(c.read).toHaveBeenCalledTimes(3);
  expect(t.revisions()).toEqual([501, 501, 501]);
  expect(c.accept).not.toHaveBeenCalled();
  expect(t.unsaved()).toBeNull();
  expect(t.states).toEqual(["saving", "saving", "saving", "idle"]);
  t.edit({ n: 1 });
  await vi.advanceTimersByTimeAsync(1000);
  expect(t.ns()).toEqual([99, 99, 99, 1]);
});

test("조건부 저장의 다음 값이 없으면 보내지 않고 conflict이다", async () => {
  const t = setup();
  const c = conditions({ next: vi.fn<Conditions["next"]>(() => null) });
  expect(await t.saver.commitConditional(c)).toBe("conflict");
  expect(c.read).toHaveBeenCalledOnce();
  expect(t.send).not.toHaveBeenCalled();
  expect(t.states).toEqual([]);
});

test.each<[string, Conditions["still"], number]>([
  ["읽기 전", () => false, 0],
  ["읽은 뒤", vi.fn<Conditions["still"]>().mockReturnValueOnce(true).mockReturnValue(false), 1],
])("조건부 저장이 %s 무효가 되면 보내지 않고 superseded이다", async (_, still, reads) => {
  const t = setup();
  const c = conditions({ still });
  expect(await t.saver.commitConditional(c)).toBe("superseded");
  expect(c.read).toHaveBeenCalledTimes(reads);
  expect(c.next).not.toHaveBeenCalled();
  expect(t.send).not.toHaveBeenCalled();
  expect(t.states).toEqual([]);
});

test("처음부터 실패: 최신본을 읽지 못하면 reject하고 이전 상태를 유지한 뒤 다시 시도로 편집을 보낸다", async () => {
  const t = setup({ send: async (_, json) => { if (!isConditional(json)) throw new ApiRequestError("network", "실패"); } });
  t.edit({ n: 1 });
  await vi.advanceTimersByTimeAsync(1000);
  const c = conditions({ read: vi.fn<Conditions["read"]>(async () => { throw new ApiRequestError("network", "읽기 실패"); }) });
  await expect(t.saver.commitConditional(c)).rejects.toThrow("읽기 실패");
  expect(t.state()).toEqual({ kind: "failed", reason: "error", message: "실패" });
  expect(t.states).toEqual(["pending", "saving", "failed", "saving", "failed"]);
  expect(t.ns()).toEqual([1, 1]);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(t.send).toHaveBeenCalledTimes(2);
  t.saver.retry();
  expect(t.ns()).toEqual([1, 1, 1]);
});

test("도중 실패: 조건부 전송이 500이면 reject하고 저장 표시를 이전 상태로 되돌린 뒤 편집을 다시 저장한다", async () => {
  const t = setup({ send: async (_, json) => { if (isConditional(json)) throw new ApiRequestError("internal", "저장 실패"); } });
  t.edit({ n: 1 });
  await vi.advanceTimersByTimeAsync(1000);
  const c = conditions();
  await expect(t.saver.commitConditional(c)).rejects.toThrow("저장 실패");
  expect(c.accept).not.toHaveBeenCalled();
  expect(t.state()).toEqual({ kind: "saved", at: 42 });
  expect(t.states).toEqual(["pending", "saving", "saved", "saving", "saved"]);
  expect(t.unsaved()).toEqual({ path: "/x", revision: 501, body: JSON.stringify({ n: 99, revision: 501 }) });
  t.edit({ n: 2 });
  await vi.advanceTimersByTimeAsync(1000);
  expect(t.ns()).toEqual([1, 99, 2]);
});

test("조건부 저장은 진행 중 전송과 대기 중 편집을 먼저 비우고, 멈춘 현재 편집은 재개 뒤 다시 시도할 때만 보낸다", async () => {
  const releases: ((ok: boolean) => void)[] = [];
  const t = setup({ send: () => new Promise<void>((resolve, reject) => releases.push((ok) => ok ? resolve() : reject(new ApiRequestError("network", "실패")))) });
  const latest = deferred<Latest>();
  const c = conditions({ read: vi.fn<Conditions["read"]>(() => latest.promise), next: vi.fn<Conditions["next"]>(() => null) });
  t.edit({ n: 1 });
  await vi.advanceTimersByTimeAsync(1000);
  t.edit({ n: 2 });
  const result = t.saver.commitConditional(c);
  expect(t.ns()).toEqual([1, 2]);
  expect(t.sent[1]!.keepalive).toBe(true);
  releases[1]!(false);
  await vi.advanceTimersByTimeAsync(0);
  expect(c.read).not.toHaveBeenCalled();
  releases[0]!(true);
  await vi.advanceTimersByTimeAsync(0);
  expect(c.read).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(10_000);
  t.saver.flush();
  t.saver.retry();
  expect(t.send).toHaveBeenCalledTimes(2);
  latest.resolve(latestOf(500));
  expect(await result).toBe("conflict");
  expect(c.next).toHaveBeenCalledWith({ n: 5 }, { kind: "failed", reason: "error", message: "실패" });
  t.saver.flush();
  expect(t.send).toHaveBeenCalledTimes(2);
  t.saver.retry();
  expect(t.ns()).toEqual([1, 2, 2]);
});

test("조건부 저장이 현재 편집을 멈춰도 더 나중의 로컬 편집은 저장한다", async () => {
  const t = setup();
  const latest = deferred<Latest>();
  const c = conditions({ read: vi.fn<Conditions["read"]>(() => latest.promise), next: vi.fn<Conditions["next"]>(() => null) });
  t.edit({ n: 1 });
  const result = t.saver.commitConditional(c);
  await vi.advanceTimersByTimeAsync(0);
  expect(c.read).toHaveBeenCalledOnce();
  t.edit({ n: 2 });
  await vi.advanceTimersByTimeAsync(1000);
  expect(t.ns()).toEqual([1, 2]);
  latest.resolve(latestOf(500));
  expect(await result).toBe("conflict");
  await vi.advanceTimersByTimeAsync(1000);
  expect(t.ns()).toEqual([1, 2]);
});

test("조건부 저장 뒤 무효가 되어 새 revision만 관찰하면 아직 남은 로컬 편집을 저장 완료로 처리하지 않는다", async () => {
  const put = deferred<void>();
  const t = setup({ send: (_, json) => isConditional(json) ? put.promise : Promise.resolve() });
  let checks = 0;
  const c = conditions({ still: vi.fn<Conditions["still"]>(() => checks++ < 2) });
  const result = t.saver.commitConditional(c);
  await vi.advanceTimersByTimeAsync(0);
  t.edit({ n: 1 });
  put.resolve();
  expect(await result).toBe("committed");
  expect(c.accept).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1000);
  expect(t.ns()).toEqual([99, 1]);
  expect(t.revisions()).toEqual([501, 502]);
  expect(t.state()).toEqual({ kind: "saved", at: 42 });
});

test("조건부 저장이 반영되면 실패한 편집의 재시도와 미저장 본문을 지우고 다음 편집에 새 revision을 쓴다", async () => {
  const t = setup({ send: async (_, json) => { if (!isConditional(json)) throw new ApiRequestError("network", "실패"); } });
  t.edit({ n: 1 });
  await vi.advanceTimersByTimeAsync(1000);
  expect(t.state().kind).toBe("failed");
  const c = conditions();
  expect(await t.saver.commitConditional(c)).toBe("committed");
  expect(c.accept).toHaveBeenCalledWith({ n: 99, revision: 501 });
  expect(t.unsaved()).toBeNull();
  expect(t.state()).toEqual({ kind: "saved", at: 42 });
  await vi.advanceTimersByTimeAsync(60_000);
  expect(t.ns()).toEqual([1, 1, 99]);
  t.edit({ n: 2 });
  await vi.advanceTimersByTimeAsync(1000);
  expect(t.ns()).toEqual([1, 1, 99, 2]);
  expect(t.revisions()).toEqual([102, 103, 501, 503]);
});
