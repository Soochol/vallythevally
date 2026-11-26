import type { Layout } from "../api/generated/Layout";
import type { LayoutWindow } from "../api/generated/LayoutWindow";
import { LINK_COLORS } from "../api/linkColors";
import type { LayoutSummary } from "../api/generated/LayoutSummary";
import type { Watchlist } from "../api/generated/Watchlist";
import type { Watchlists } from "../api/generated/Watchlists";
import { ApiRequestError } from "../api/http";
import { parseChartSettings } from "../chart/settings";
import { MAX_WINDOWS, windowId, WINDOW_KINDS, type WindowKind } from "../layout/kinds";
import { parsePlacement } from "../layout/placement";
import { isRanking } from "../features/ranking/rankingShape";
import { alignLinks, DEFAULT_LAYOUT, type BrokerCards, type BrokerView, type EditableLayout, type WindowState } from "../stores/layout";
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
  unsaved(target: SaveTarget): Unsaved | null;
}

export interface Restored {
  layout: EditableLayout;
  layoutDirty: boolean;
  serverCharts: readonly string[];
  ui: { prefs: UiPrefs; extra: UiExtra };
  uiDirty: boolean;
  watchlists: readonly Watchlist[];
  watchlistDirty: boolean;
  serverRevisions: Record<SaveTarget, number>;
  revisions: Record<SaveTarget, number>;
}

const revisionOf = (raw: unknown): number => {
  const r = typeof raw === "object" && raw !== null ? (raw as { revision?: unknown }).revision : undefined;
  return typeof r === "number" ? r : 0;
};

function newer(u: Unsaved | null, path: string, serverRevision: number): { value: Record<string, unknown>; revision: number } | null {
  if (u === null || u.path !== path || u.revision <= serverRevision) return null;
  const value = unsavedValue(u);
  return value && { value, revision: u.revision };
}

const isFields = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const WINDOW_ID = /^[A-Za-z0-9_-]{1,64}$/;
const RETIRED_WINDOW_KIND = "objects";
const DRAFT_LINKS: readonly unknown[] = [null, ...LINK_COLORS];
const isWindowKind = (k: unknown): k is WindowKind => typeof k === "string" && Object.hasOwn(WINDOW_KINDS, k);

const STOCK_CODE = /^[0-9A-Z]{6}$/;
const MAX_WATCHLIST_ID_BYTES = 64;
const MAX_SCREEN_ID_BYTES = 64;
const absent = (v: unknown): boolean => v === undefined || v === null;
const isId = (v: unknown, maxBytes: number): v is string => typeof v === "string" && v.length > 0 && new TextEncoder().encode(v).length <= maxBytes;
const isPin = (v: unknown): boolean => absent(v) || (typeof v === "string" && STOCK_CODE.test(v));
const PINNABLE_KINDS: readonly WindowKind[] = ["trades", "book", "program", "brokers", "order", "premarket"];
const BROKER_VIEWS: readonly unknown[] = ["board", "list", "table"];
const BROKER_CARDS: readonly unknown[] = ["bars", "both", "numbers"];
const isBrokerView = (v: unknown): v is BrokerView => BROKER_VIEWS.includes(v);
const isBrokerCards = (v: unknown): v is BrokerCards => BROKER_CARDS.includes(v);

function isDraftWindow(w: unknown): w is LayoutWindow {
  if (!isFields(w) || typeof w.id !== "string" || !WINDOW_ID.test(w.id) || !DRAFT_LINKS.includes(w.link) || !isWindowKind(w.kind)) return false;
  if (w.kind === "watchlist") return absent(w.list) || isId(w.list, MAX_WATCHLIST_ID_BYTES);
  if (w.kind === "screener") return absent(w.screen) || isId(w.screen, MAX_SCREEN_ID_BYTES);
  if (PINNABLE_KINDS.includes(w.kind) && !isPin(w.symbol)) return false;
  if (w.kind === "brokers") return (absent(w.view) || isBrokerView(w.view)) && (absent(w.cards) || isBrokerCards(w.cards));
  if (w.kind === "ranking") return isRanking(w.ranking);
  if (w.kind === "order") return w.venue === "combined" || w.venue === "krx" || w.venue === "nxt";
  return w.kind !== "chart" || (typeof w.symbol === "string" && typeof w.period === "string" && (w.venue === null || typeof w.venue === "string") && "chartSettings" in w);
}

const isRetiredWindow = (w: unknown): boolean => isFields(w) && w.kind === RETIRED_WINDOW_KIND;

function readDraftWindows(draft: unknown): LayoutWindow[] | null {
  const raw = Array.isArray(draft) ? draft.filter((w) => !isRetiredWindow(w)) : draft;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_WINDOWS || !raw.every(isDraftWindow)) return null;
  if (new Set(raw.map((w) => w.id)).size !== raw.length) return null;
  const counts = new Map<WindowKind, number>();
  for (const w of raw) counts.set(w.kind, (counts.get(w.kind) ?? 0) + 1);
  const fits = [...counts].every(([kind, n]) => n <= WINDOW_KINDS[kind].maxCount);
  return fits && counts.has("chart") ? raw : null;
}

function asLayout(v: Record<string, unknown>, stored: Layout): Layout | null {
  const windows = readDraftWindows(v.windows);
  const { sync } = v;
  const ok = v.id === stored.id && typeof v.name === "string" && windows !== null && isFields(v.placement) && isFields(sync);
  return ok ? ({ ...stored, ...v, sync: { ...stored.sync, ...sync }, windows } as Layout) : null;
}

export async function restore(src: RestoreSources): Promise<Restored> {
  const [rawUi, serverWatch] = await Promise.all([src.uiState(), src.watchlists()]);
  const serverUi = revisionOf(rawUi);
  const localUi = newer(src.unsaved("ui"), UI_STATE_PATH, serverUi);
  const ui = parseUiState(localUi?.value ?? rawUi);
  const localWatch = newer(src.unsaved("watchlist"), WATCHLISTS_PATH, serverWatch.revision);
  const localLists = localWatch ? parseWatchlists(localWatch.value.lists) : null;

  const stored = await openLayout(src, ui.prefs.lastLayoutId);
  const restored = stored ? await restoreLayout(stored, src) : {
    layout: DEFAULT_LAYOUT, dirty: true, serverCharts: [], revision: 0, serverRevision: 0,
  };
  const { layout } = restored;
  const lastLayoutFixed = ui.prefs.lastLayoutId !== layout.id;
  const serverRevisions = { layout: stored?.revision ?? 0, ui: serverUi, watchlist: serverWatch.revision };
  return {
    layout,
    layoutDirty: restored.dirty,
    serverCharts: restored.serverCharts,
    ui: lastLayoutFixed ? { ...ui, prefs: { ...ui.prefs, lastLayoutId: layout.id } } : ui,
    uiDirty: lastLayoutFixed || localUi !== null,
    watchlists: localLists ?? serverWatch.lists,
    watchlistDirty: localLists !== null,
    serverRevisions,
    revisions: {
      layout: restored.revision,
      ui: Math.max(serverUi, localUi?.revision ?? 0),
      watchlist: Math.max(serverWatch.revision, localLists ? localWatch!.revision : 0),
    },
  };
}

export interface RestoredLayout {
  layout: EditableLayout;
  dirty: boolean;
  serverCharts: readonly string[];
  serverRevision: number;
  revision: number;
}

export async function restoreLayout(stored: Layout, src: Pick<RestoreSources, "unsaved">): Promise<RestoredLayout> {
  const local = newer(src.unsaved("layout"), layoutPath(stored.id), stored.revision);
  const opened = (local && asLayout(local.value, stored)) || stored;
  const restoredWindows = opened.windows.map(restoreWindow);
  const linkedWindows = alignLinks(restoredWindows);
  return {
    layout: { id: opened.id, name: opened.name, sync: opened.sync, windows: linkedWindows, placement: parsePlacement(opened.placement) },
    dirty: opened !== stored || linkedWindows !== restoredWindows,
    serverCharts: stored.windows.filter((w) => w.kind === "chart").map((w) => w.id),
    serverRevision: stored.revision,
    revision: Math.max(stored.revision, opened !== stored ? (local?.revision ?? 0) : 0),
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

const optional = <K extends string>(key: K, value: string | null | undefined): { [P in K]?: string } => (typeof value === "string" ? ({ [key]: value } as { [P in K]?: string }) : {});

function restoreWindow(raw: LayoutWindow): WindowState {
  const base = { id: windowId(raw.id), link: raw.link };
  switch (raw.kind) {
    case "order":
      return { ...base, kind: raw.kind, venue: raw.venue, ...optional("symbol", raw.symbol) };
    case "watchlist":
      return { ...base, kind: raw.kind, ...optional("list", raw.list) };
    case "screener":
      return { ...base, kind: raw.kind, ...optional("screen", raw.screen) };
    case "trades":
    case "book":
    case "program":
    case "premarket":
      return { ...base, kind: raw.kind, ...optional("symbol", raw.symbol) };
    case "brokers":
      return {
        ...base,
        kind: raw.kind,
        ...optional("symbol", raw.symbol),
        ...(raw.view && raw.view !== "board" ? { view: raw.view } : {}),
        ...(raw.cards && raw.cards !== "both" ? { cards: raw.cards } : {}),
      };
    case "ranking":
      return { ...base, kind: raw.kind, ranking: raw.ranking };
    case "indicators":
      return { ...base, kind: raw.kind };
    case "chart":
      break;
  }
  const { venue: _venue, ...chart } = raw;
  return { ...chart, id: windowId(raw.id), chartSettings: parseChartSettings(raw.chartSettings) };
}
