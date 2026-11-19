export type PageId = "workspace" | "home" | "market" | "heatmap" | "etf";

export interface PageEntry {
  id: PageId;
  path: string;
  label: string;
}

export const RAIL_PAGES = [
  { id: "workspace", path: "/", label: "작업 영역" },
  { id: "market", path: "/market", label: "시장 종합" },
  { id: "heatmap", path: "/heatmap", label: "히트맵" },
  { id: "etf", path: "/etf", label: "ETF" },
] as const satisfies readonly PageEntry[];

export const HOME_PAGE = { id: "home", path: "/home", label: "랜딩" } as const satisfies PageEntry;

export const ALL_PAGES: readonly PageEntry[] = [...RAIL_PAGES, HOME_PAGE];

export const SHORTCUT_PAGES = RAIL_PAGES.filter((page) => page.id !== "workspace");

export function pageOfPath(pathname: string): PageId | null {
  const path = pathname.replace(/\/+$/, "") || "/";
  return ALL_PAGES.find((page) => page.path === path)?.id ?? null;
}

export const pathOfPage = (id: PageId): string => ALL_PAGES.find((page) => page.id === id)!.path;

export type ContentPageId = "market" | "heatmap" | "etf";

export const isContentPage = (id: PageId): id is ContentPageId => id === "market" || id === "heatmap" || id === "etf";
