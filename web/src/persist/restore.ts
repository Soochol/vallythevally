import type { Layout } from "../api/generated/Layout";
import type { LayoutWindow } from "../api/generated/LayoutWindow";
import type { LayoutSummary } from "../api/generated/LayoutSummary";
import type { SymbolCode } from "../api/generated/SymbolCode";
import type { SymbolInfo } from "../api/generated/SymbolInfo";
import type { Watchlist } from "../api/generated/Watchlist";
import type { Watchlists } from "../api/generated/Watchlists";
import { ApiRequestError } from "../api/http";
import { parseChartSettings } from "../chart/settings";
import { windowId } from "../layout/kinds";
import { parsePlacement } from "../layout/placement";
import { venueFor } from "../lib/venue";
import { type ChartWindowState, DEFAULT_LAYOUT, type EditableLayout, type WindowState } from "../stores/layout";
import { layoutPath, UI_STATE_PATH, WATCHLISTS_PATH } from "../api/userData";
import { parseWatchlists } from "../lib/watchlist";
import type { SaveTarget } from "../stores/persist";
import type { Unsaved } from "./saver";
import { parseUiState, type UiExtra, type UiPrefs } from "./uiState";
import { unsavedValue } from "./unsaved";

export interface RestoreSources {
  uiState(): Promise<unknown>;
  layouts(): Promise<LayoutSummary[]>;
  layout(id: string): Promise<Layout>;
  watchlists(): Promise<Watchlists>;
  symbolInfo(code: SymbolCode): Promise<SymbolInfo>;
  unsaved(target: SaveTarget): Unsaved | null;
}

export interface Restored {
  layout: EditableLayout;
  layoutDirty: boolean;
  ui: { prefs: UiPrefs; extra: UiExtra };
  uiDirty: boolean;
  watchlists: readonly Watchlist[];
  watchlistDirty: boolean;
  serverRevisions: Record<SaveTarget, number>;
  revisions: Record<SaveTarget, number>;
  notices: string[];
}

export const NXT_FALLBACK_NOTICE = "NXT에서 거래되지 않아 통합으로 엽니다";

const revisionOf = (raw: unknown): number => {
  const r = typeof raw === "object" && raw !== null ? (raw as { revision?: unknown }).revision : undefined;
  return typeof r === "number" ? r : 0;
};

function newer(u: Unsaved | null, path: string, serverRevision: number): { value: Record<string, unknown>; revision: number } | null {
  if (u === null || u.path !== path || u.revision <= serverRevision) return null;
  const value = unsavedValue(u);
  return value && { value, revision: u.revision };
}

function asLayout(v: Record<string, unknown>, stored: Layout): Layout | null {
  const placementIsObject = typeof v.placement === "object" && v.placement !== null && !Array.isArray(v.placement);
  const ok = v.id === stored.id && typeof v.name === "string" && Array.isArray(v.windows) && placementIsObject && typeof v.sync === "object";
  return ok ? ({ ...stored, ...v } as Layout) : null;
}

export async function restore(src: RestoreSources): Promise<Restored> {
  const [rawUi, serverWatch] = await Promise.all([src.uiState(), src.watchlists()]);
  const serverUi = revisionOf(rawUi);
  const localUi = newer(src.unsaved("ui"), UI_STATE_PATH, serverUi);
  const ui = parseUiState(localUi?.value ?? rawUi);
  const localWatch = newer(src.unsaved("watchlist"), WATCHLISTS_PATH, serverWatch.revision);
  const localLists = localWatch ? parseWatchlists(localWatch.value.lists) : null;

  const stored = await openLayout(src, ui.prefs.lastLayoutId);
  const localLayout = stored && newer(src.unsaved("layout"), layoutPath(stored.id), stored.revision);
  const opened = (stored && localLayout && asLayout(localLayout.value, stored)) || stored;
  const windows = await Promise.all((opened?.windows ?? []).map((w) => restoreWindow(src, w)));
  const layout: EditableLayout = opened
    ? { id: opened.id, name: opened.name, sync: opened.sync, windows: windows.map((w) => w.window), placement: parsePlacement(opened.placement) }
    : DEFAULT_LAYOUT;
  const notices = windows.some((w) => w.nxtFellBack) ? [NXT_FALLBACK_NOTICE] : [];
  const lastLayoutFixed = ui.prefs.lastLayoutId !== layout.id;
  const serverRevisions = { layout: stored?.revision ?? 0, ui: serverUi, watchlist: serverWatch.revision };
  return {
    layout,
    layoutDirty: stored === null || opened !== stored || windows.some((w) => w.dirty),
    ui: lastLayoutFixed ? { ...ui, prefs: { ...ui.prefs, lastLayoutId: layout.id } } : ui,
    uiDirty: lastLayoutFixed || localUi !== null,
    watchlists: localLists ?? serverWatch.lists,
    watchlistDirty: localLists !== null,
    serverRevisions,
    revisions: {
      layout: Math.max(serverRevisions.layout, opened !== stored ? (localLayout?.revision ?? 0) : 0),
      ui: Math.max(serverUi, localUi?.revision ?? 0),
      watchlist: Math.max(serverWatch.revision, localLists ? localWatch!.revision : 0),
    },
    notices,
  };
}

async function openLayout(src: RestoreSources, id: string | null): Promise<Layout | null> {
  if (id !== null) {
    try {
      return await src.layout(id);
    } catch (e) {
      if (!(e instanceof ApiRequestError && e.code === "not_found")) throw e;
    }
  }
  const first = (await src.layouts())[0];
  return first ? src.layout(first.id) : null;
}

interface RestoredWindow {
  window: WindowState;
  dirty: boolean;
  nxtFellBack: boolean;
}

async function restoreWindow(src: RestoreSources, raw: LayoutWindow): Promise<RestoredWindow> {
  if (raw.kind !== "chart") return { window: { id: windowId(raw.id), link: raw.link, kind: raw.kind }, dirty: false, nxtFellBack: false };
  const cell: ChartWindowState = { ...raw, id: windowId(raw.id), chartSettings: parseChartSettings(raw.chartSettings) };
  let info: Pick<SymbolInfo, "code" | "nxtEnabled">;
  try {
    info = await src.symbolInfo(cell.symbol);
  } catch {
    return { window: cell, dirty: false, nxtFellBack: false };
  }
  const venue = venueFor(info, cell.venue);
  if (venue === cell.venue) return { window: cell, dirty: false, nxtFellBack: false };
  return { window: { ...cell, venue }, dirty: true, nxtFellBack: cell.venue === "nxt" };
}
