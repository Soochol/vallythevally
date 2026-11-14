import type { LayoutWindow } from "../api/generated/LayoutWindow";

export const WINDOW_HEAD_HEIGHT = 34;

export type LinkRole = "follows" | "sends" | "none";
export type HomeSpot = "wide" | "side";

export interface WindowKindSpec {
  readonly name: string;
  readonly minSize: { readonly w: number; readonly h: number };
  readonly maxCount: number;
  readonly link: LinkRole;
  readonly home: HomeSpot;
}

export const WINDOW_KINDS = Object.freeze({
  chart: { name: "차트", minSize: { w: 280, h: 160 }, maxCount: 8, link: "follows", home: "wide" },
  watchlist: { name: "관심종목", minSize: { w: 220, h: 180 }, maxCount: 1, link: "sends", home: "side" },
  screener: { name: "스크리너", minSize: { w: 280, h: 240 }, maxCount: 1, link: "sends", home: "side" },
  objects: { name: "개체 목록", minSize: { w: 220, h: 140 }, maxCount: 1, link: "none", home: "side" },
  indicators: { name: "지표", minSize: { w: 240, h: 140 }, maxCount: 1, link: "none", home: "side" },
} as const satisfies Record<LayoutWindow["kind"], WindowKindSpec>);

export type WindowKind = keyof typeof WINDOW_KINDS;

export const WINDOW_KIND_LIST: readonly WindowKind[] = Object.freeze(Object.keys(WINDOW_KINDS) as WindowKind[]);

export const allowsMany = (kind: WindowKind): boolean => WINDOW_KINDS[kind].maxCount > 1;

export type WindowId = string & { readonly __brand: "WindowId" };

export const windowId = (raw: string): WindowId => raw as WindowId;

export interface WindowRef {
  id: WindowId;
  kind: WindowKind;
}
