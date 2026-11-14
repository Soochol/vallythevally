import { expect, test } from "vitest";
import { WINDOW_KIND_LIST, type WindowRef } from "../kinds";
import type { CanvasPlacement, Rect } from "../placement";
import { bringToFront, fitCanvas, rectsForArea, tidyWindows } from "./arrange";
import { minWindowSize, toRatio, type Size } from "./geometry";
import { moveRect, resizeRect, type ResizeHandle } from "./snap";
import { AREA, expectPlacementInvariants, win, WINDOWS } from "./testing";

const HANDLES: readonly ResizeHandle[] = ["n", "s", "e", "w", "ne", "nw", "se", "sw"];
const AREAS: readonly Size[] = [AREA, { w: AREA.w / 2, h: AREA.h / 2 }, { w: 1920, h: 1000 }, { w: 400, h: 260 }, { w: 1280, h: 200 }];

function random(seed: number) {
  let state = seed;
  const next = () => ((state = (state * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  return { next, int: (n: number) => Math.floor(next() * n), pick: <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]! };
}

type State = { placement: CanvasPlacement; windows: WindowRef[]; area: Size; added: number };

function step(state: State, rng: ReturnType<typeof random>): State {
  const { placement, windows, area } = state;
  const drawn = rectsForArea(placement, windows, area);
  const target = rng.pick(windows);
  const others = windows.filter((window) => window !== target).map((window) => drawn[window.id]!);
  const offset = { x: (rng.next() - 0.5) * 3000, y: (rng.next() - 0.5) * 1500 };
  const store = (rect: Rect): State => ({
    ...state,
    placement: bringToFront({ ...placement, rects: { ...placement.rects, [target.id]: toRatio(rect, area) } }, target.id),
  });
  switch (rng.int(6)) {
    case 0:
      return store(moveRect(drawn[target.id]!, offset, others, area).rect);
    case 1:
      return store(resizeRect(drawn[target.id]!, rng.pick(HANDLES), offset, minWindowSize(target.kind), others, area).rect);
    case 2: {
      const { rects } = tidyWindows(windows, area);
      const tidied = Object.fromEntries(windows.map(({ id }) => [id, toRatio(rects[id]!, area)])) as CanvasPlacement["rects"];
      return { ...state, placement: { ...placement, rects: tidied } };
    }
    case 3:
      return { ...state, area: rng.pick(AREAS) };
    case 4: {
      if (windows.length >= 12) return state;
      const added = [...windows, win(`n${state.added}`, rng.pick(WINDOW_KIND_LIST))];
      return { ...state, windows: added, added: state.added + 1, placement: fitCanvas(placement, added, area) };
    }
    default: {
      if (windows.length <= 1 || target.kind === "chart") return state;
      const left = windows.filter((window) => window !== target);
      return { ...state, windows: left, placement: fitCanvas(placement, left, area) };
    }
  }
}

test("연산을 여러 번 이어 적용해도 창마다 사각형과 순서 항목이 하나씩 있고 창 머리는 영역 안에 있다", () => {
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const rng = random(seed);
    let state: State = { placement: fitCanvas(null, WINDOWS, AREA), windows: [...WINDOWS], area: AREA, added: 0 };
    expectPlacementInvariants(state.placement, state.windows, state.area);
    for (let i = 0; i < 150; i++) {
      state = step(state, rng);
      expectPlacementInvariants(state.placement, state.windows, state.area);
      expect(fitCanvas(state.placement, state.windows, state.area).order).toEqual(state.placement.order);
    }
  }
});
