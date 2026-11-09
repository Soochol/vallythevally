import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ApiRequestError } from "../api/http";
import { createSaver, type SaveState, type SaverOptions } from "./saver";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

/** 값 하나를 저장하는 saver. send는 기본으로 성공한다. 보낸 본문과 지나간 상태를 모은다. */
type Send = SaverOptions<unknown>["send"];

function setup({ send: sendImpl }: { send?: Send } = {}) {
  let value: { n: number; pad?: string } = { n: 0 };
  const sent: { json: string; keepalive: boolean }[] = [];
  const states: SaveState["kind"][] = [];
  let last: SaveState = { kind: "idle" };
  const send = vi.fn<Send>(async (json, { keepalive }) => {
    sent.push({ json, keepalive });
    return sendImpl?.(json, { keepalive });
  });
  const saver = createSaver({
    debounceMs: 1000,
    read: () => value,
    tooLarge: (v) => (v.pad?.length ?? 0) > 10,
    send,
    onState: (s) => {
      last = s;
      states.push(s.kind);
    },
    now: () => 42,
  });
  const edit = (v: { n: number; pad?: string }) => {
    value = v;
    saver.changed();
  };
  return { saver, edit, send, sent, states, state: () => last };
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
  expect(t.sent).toEqual([{ json: '{"n":2}', keepalive: false }]);
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
  expect(t.send.mock.calls[1]![0]).toBe('{"n":2}');
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
  expect(t.sent.map((s) => s.json)).toEqual(['{"n":2}']);
});

test("화면이 스스로 줄일 수 있으면 줄여서 한 번 보낸다", async () => {
  let value: { n: number; pad?: string } = { n: 1, pad: "x".repeat(11) };
  const shrink = vi.fn(() => {
    if (!value.pad) return false;
    value = { n: value.n };
    saver.changed(); // 줄인 것도 편집이다(스토어 구독이 부른다)
    return true;
  });
  const send = vi.fn(async () => {});
  const saver = createSaver({ debounceMs: 1000, read: () => value, tooLarge: (v) => (v.pad?.length ?? 0) > 10, shrink, send, onState: () => {} });
  saver.changed();
  await vi.advanceTimersByTimeAsync(5000);
  expect(shrink).toHaveBeenCalledOnce();
  expect(send.mock.calls).toEqual([['{"n":1}', { keepalive: false }]]);
});

test("탭이 숨으면 기다리던 편집을 keepalive로 곧바로 보낸다", async () => {
  const t = setup();
  t.edit({ n: 1 });
  t.saver.flush();
  await vi.advanceTimersByTimeAsync(0);
  expect(t.sent).toEqual([{ json: '{"n":1}', keepalive: true }]);
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
