import type { LayoutWindow } from "../api/generated/LayoutWindow";

export const WINDOW_HEAD_HEIGHT = 34;
export const MAX_WINDOWS = 50;

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
  watchlist: { name: "관심종목", minSize: { w: 220, h: 180 }, maxCount: MAX_WINDOWS, link: "sends", home: "side" },
  screener: { name: "스크리너", minSize: { w: 280, h: 240 }, maxCount: MAX_WINDOWS, link: "sends", home: "side" },
  indicators: { name: "지표", minSize: { w: 300, h: 200 }, maxCount: 1, link: "none", home: "side" },
  trades: { name: "체결", minSize: { w: 220, h: 200 }, maxCount: MAX_WINDOWS, link: "follows", home: "side" },
  book: { name: "10호가", minSize: { w: 424, h: 300 }, maxCount: MAX_WINDOWS, link: "follows", home: "side" },
  program: { name: "프로그램 체결", minSize: { w: 260, h: 240 }, maxCount: MAX_WINDOWS, link: "follows", home: "side" },
  brokers: { name: "거래원 입체분석", minSize: { w: 360, h: 300 }, maxCount: MAX_WINDOWS, link: "follows", home: "wide" },
  order: { name: "호가주문", minSize: { w: 552, h: 520 }, maxCount: MAX_WINDOWS, link: "follows", home: "wide" },
  ranking: { name: "순위", minSize: { w: 320, h: 240 }, maxCount: MAX_WINDOWS, link: "sends", home: "side" },
} as const satisfies Record<LayoutWindow["kind"], WindowKindSpec>);

export type WindowKind = keyof typeof WINDOW_KINDS;

export const WINDOW_KIND_LIST: readonly WindowKind[] = Object.freeze(Object.keys(WINDOW_KINDS) as WindowKind[]);

export const allowsMany = (kind: WindowKind): boolean => WINDOW_KINDS[kind].maxCount > 1;
export const isSingleton = (kind: WindowKind): boolean => WINDOW_KINDS[kind].maxCount === 1;

export type WindowId = string & { readonly __brand: "WindowId" };

export const windowId = (raw: string): WindowId => raw as WindowId;

export interface WindowRef {
  id: WindowId;
  kind: WindowKind;
}
