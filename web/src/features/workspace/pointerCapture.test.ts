import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { watchPointerCapture } from "./pointerCapture";

let frames: FrameRequestCallback[] = [];
const runFrame = () => { const next = frames; frames = []; next.forEach((callback) => callback(0)); };
const target = (held: { value: boolean }) => ({ hasPointerCapture: (pointer: number) => pointer === 1 && held.value }) as Element;

beforeEach(() => {
  frames = [];
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => frames.push(callback));
});
afterEach(() => vi.unstubAllGlobals());

test("잡고 있는 동안은 프레임마다 다음 프레임을 요청하고 끝내지 않는다", () => {
  const onLost = vi.fn();
  watchPointerCapture(target({ value: true }), 1, () => true, onLost);
  runFrame();
  runFrame();
  expect(onLost).not.toHaveBeenCalled();
  expect(frames).toHaveLength(1);
});

test("잡기를 잃으면 다음 프레임에 한 번 끝내고 프레임을 더 요청하지 않는다", () => {
  const onLost = vi.fn();
  const held = { value: true };
  watchPointerCapture(target(held), 1, () => true, onLost);
  runFrame();
  held.value = false;
  runFrame();
  expect(onLost).toHaveBeenCalledTimes(1);
  expect(frames).toHaveLength(0);
});

test("끌기가 끝났으면 잡기가 없어도 끝내지 않고 감시를 멈춘다", () => {
  const onLost = vi.fn();
  const dragging = { value: true };
  watchPointerCapture(target({ value: true }), 1, () => dragging.value, onLost);
  runFrame();
  dragging.value = false;
  runFrame();
  expect(onLost).not.toHaveBeenCalled();
  expect(frames).toHaveLength(0);
});
