import type { Rect } from "../placement";
import type { DockLayout } from "./geometry";
import type { SplitPath } from "./tree";

export type Junction = { rowPath: SplitPath; columnPath: SplitPath; rect: Rect };

export const JUNCTION_SIZE = 12;

const spansTouch = (aStart: number, aLength: number, bStart: number, bLength: number): boolean =>
  aStart <= bStart + bLength && bStart <= aStart + aLength;

export function findJunctions(layout: DockLayout, size: number = JUNCTION_SIZE): Junction[] {
  const vertical = layout.gutters.filter((gutter) => gutter.node.dir === "row");
  const horizontal = layout.gutters.filter((gutter) => gutter.node.dir === "column");
  return vertical.flatMap((across) =>
    horizontal
      .filter(
        (along) =>
          spansTouch(across.rect.x, across.rect.w, along.bounds.x, along.bounds.w) &&
          spansTouch(along.rect.y, along.rect.h, across.bounds.y, across.bounds.h),
      )
      .map((along) => ({
        rowPath: across.path,
        columnPath: along.path,
        rect: { x: across.rect.x + across.rect.w / 2 - size / 2, y: along.rect.y + along.rect.h / 2 - size / 2, w: size, h: size },
      })),
  );
}
