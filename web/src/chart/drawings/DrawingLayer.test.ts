import { expect, test } from "vitest";
import { paintShape } from "./DrawingLayer";
import type { ScreenPoint } from "./types";

function recordingCanvas() {
  const path: ScreenPoint[] = [];
  const record = (x: number, y: number) => path.push({ x, y });
  const canvas = new Proxy({ moveTo: record, lineTo: record } as Record<string | symbol, unknown>, {
    get: (target, key) => target[key] ?? (() => undefined),
    set: () => true,
  });
  return { canvas: canvas as unknown as CanvasRenderingContext2D, path };
}

const stroke = { color: "#ffffff", width: 2, dash: "solid" } as const;
const pane = { width: 800, height: 400 };

test("두 점이 1px보다 가까운 연장 선분도 화면 끝까지 그린다", () => {
  const { canvas, path } = recordingCanvas();
  paintShape(canvas, { kind: "segment", a: { x: 100, y: 50 }, b: { x: 100.5, y: 50 }, stroke, extend: "right" }, pane);
  expect(path[0]).toEqual({ x: 100, y: 50 });
  expect(path[1]!.x).toBeGreaterThanOrEqual(800);
  expect(path[1]!.y).toBe(50);
});

test("두 점이 화면 밖 대각선 멀리 있어도 연장 선분은 화면을 가로지른다", () => {
  const { canvas, path } = recordingCanvas();
  paintShape(canvas, { kind: "segment", a: { x: -5000, y: -5000 }, b: { x: -4999, y: -4999 }, stroke, extend: "right" }, pane);
  expect(path[1]!.x).toBeCloseTo(path[1]!.y);
  expect(path[1]!.y).toBeGreaterThanOrEqual(pane.height);
});
