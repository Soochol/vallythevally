import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ApiRequestError } from "../api/http";
import { createSaver, type SaveState, type SaverOptions, type Unsaved } from "./saver";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

/** 값 하나를 저장하는 saver. send는 기본으로 성공한다. 보낸 본문과 지나간 상태, 미저장 본문을 모은다. */
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
  /** 보낸 본문들의 n. */
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
  // 응답이 거꾸로 와도(나중 것 먼저) 저장됨으로 끝나고 다시 보내지 않는다.
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
  // 탭이 닫혀 응답 처리기가 끝내 돌지 않아도, 최신 편집은 미저장 본문으로 남아 있다.
  pending[0]!(true);
  await vi.advanceTimersByTimeAsync(0);
  // 앞 요청의 성공은 더 새 본문을 지우지 않는다.
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
