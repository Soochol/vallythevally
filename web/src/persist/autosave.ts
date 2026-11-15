import type { LayoutInput } from "../api/generated/LayoutInput";
import { ApiRequestError } from "../api/http";
import type { UiState } from "../api/generated/UiState";
import type { Watchlists } from "../api/generated/Watchlists";
import { fetchWatchlists, layoutPath, UI_STATE_PATH, WATCHLISTS_PATH } from "../api/userData";
import { chartWindows, type EditableLayout, useLayoutStore } from "../stores/layout";
import { type SaveTarget, usePersistStore } from "../stores/persist";
import { useUiStore } from "../stores/ui";
import { useWatchlistStore } from "../stores/watchlist";
import { exceedsLimit, WATCHLISTS_LIMIT_BYTES } from "./bytes";
import { type CommitOutcome, type ConditionalCommit, createSaver, type Saver, type SaverOptions } from "./saver";
import { clearUnsaved, writeUnsaved } from "./unsaved";
import { toUiState } from "./uiState";

const DEBOUNCE_MS = 1000;
export const RECENT_CLEARED = "최근 본 종목 기록을 지웠습니다";

export interface AutosaveDeps {
  put(path: string, json: string, opts: { keepalive: boolean }): Promise<unknown>;
  toast(text: string): void;
  revisions: Record<SaveTarget, number>;
  serverCharts?: readonly string[];
  unsaved?: (target: SaveTarget) => SaverOptions<object>["unsaved"];
}

type WatchlistsBody = Omit<Watchlists, "revision">;

export interface Autosave {
  savers: { layout: Saver<Omit<LayoutInput, "revision">>; ui: Saver<Omit<UiState, "revision">>; watchlist: Saver<WatchlistsBody> };
  retry(): void;
  flush(): void;
  stop(): void;
}

type ServerLayout = { revision: number; charts: ReadonlySet<string> | null };

let active: Autosave | null = null;
let savedLayout: ServerLayout = { revision: -Infinity, charts: null };
let unsureLayouts: ServerLayout[] = [];
const sendingCharts = new Set<ReadonlySet<string>>();

export function serverMayLackChart(id: string): boolean {
  const candidates = [savedLayout, ...unsureLayouts];
  return active === null || candidates.some(({ charts }) => charts === null || !charts.has(id)) || [...sendingCharts].some((charts) => !charts.has(id));
}

function layoutSent(json: string): ServerLayout & { charts: ReadonlySet<string> } {
  const { windows, revision } = JSON.parse(json) as Pick<LayoutInput, "windows" | "revision">;
  return { revision, charts: new Set(windows.filter((w) => w.kind === "chart").map((w) => w.id)) };
}

export function retryFailedSaves() {
  active?.retry();
}

export function commitWatchlist(c: Pick<ConditionalCommit<WatchlistsBody>, "next" | "still">): Promise<CommitOutcome> {
  if (!active) return Promise.reject(new Error("관심종목 저장이 시작되지 않았습니다"));
  return active.savers.watchlist.commitConditional({
    ...c,
    read: async () => {
      const { revision, ...value } = await fetchWatchlists();
      return { value, revision };
    },
    accept: (saved) => useWatchlistStore.getState().load(saved.lists, saved.revision),
  });
}

const addsChartWindow = (before: EditableLayout, after: EditableLayout) => {
  const known = new Set<string>(chartWindows(before).map((w) => w.id));
  return before.id === after.id && chartWindows(after).some((w) => !known.has(w.id));
};

const exceedsServerFieldLimits = (l: Omit<LayoutInput, "revision">) =>
  l.windows.some((w) => w.kind === "chart" && exceedsLimit(w.chartSettings)) || exceedsLimit(l.placement);

export function startAutosave(deps: AutosaveDeps): Autosave {
  const setSave = usePersistStore.getState().setSave;
  const unsaved =
    deps.unsaved ?? ((target: SaveTarget) => ({ write: (u) => writeUnsaved(target, u), clear: (upTo) => clearUnsaved(target, upTo) }));

  savedLayout = { revision: -Infinity, charts: deps.serverCharts ? new Set(deps.serverCharts) : null };
  unsureLayouts = [];
  sendingCharts.clear();
  const layout = createSaver<Omit<LayoutInput, "revision">>({
    debounceMs: DEBOUNCE_MS,
    read: () => {
      const { id, name, sync, windows, placement } = useLayoutStore.getState().layout;
      return { id, name, sync, windows, placement };
    },
    tooLarge: exceedsServerFieldLimits,
    path: () => layoutPath(useLayoutStore.getState().layout.id),
    revision: deps.revisions.layout,
    send: async (path, json, opts) => {
      const sent = layoutSent(json);
      sendingCharts.add(sent.charts);
      try {
        const saved = await deps.put(path, json, opts);
        if (sent.revision > savedLayout.revision) savedLayout = sent;
        unsureLayouts = unsureLayouts.filter((layout) => layout.revision > savedLayout.revision);
        return saved;
      } catch (e) {
        const stale = e instanceof ApiRequestError && e.code === "stale_revision";
        if (sent.revision > savedLayout.revision) unsureLayouts = [...unsureLayouts, stale ? { revision: sent.revision, charts: null } : sent];
        throw e;
      } finally {
        sendingCharts.delete(sent.charts);
      }
    },
    unsaved: unsaved("layout"),
    onState: (s) => setSave("layout", s),
  });

  const ui = createSaver({
    debounceMs: DEBOUNCE_MS,
    read: () => {
      const { prefs, extra } = useUiStore.getState();
      return toUiState(prefs, extra);
    },
    // 서버는 revision까지 담은 본문을 잰다. 가장 긴 revision으로 잰다.
    tooLarge: (v) => exceedsLimit({ ...v, revision: Number.MAX_SAFE_INTEGER }),
    shrink: () => {
      const store = useUiStore.getState();
      if (store.prefs.recentSymbols.length === 0) return false;
      store.clearRecent();
      deps.toast(RECENT_CLEARED);
      return true;
    },
    path: () => UI_STATE_PATH,
    revision: deps.revisions.ui,
    send: deps.put,
    unsaved: unsaved("ui"),
    onState: (s) => setSave("ui", s),
  });

  const watchlist = createSaver<WatchlistsBody>({
    debounceMs: 0,
    read: () => ({ lists: [...useWatchlistStore.getState().lists] }),
    tooLarge: (v) => exceedsLimit({ ...v, revision: Number.MAX_SAFE_INTEGER }, WATCHLISTS_LIMIT_BYTES),
    path: () => WATCHLISTS_PATH,
    revision: deps.revisions.watchlist,
    send: deps.put,
    unsaved: unsaved("watchlist"),
    onState: (s) => setSave("watchlist", s),
  });

  const unsubscribe = [
    useLayoutStore.subscribe((s, prev) => s.revision !== prev.revision && layout.changed(addsChartWindow(prev.layout, s.layout) ? "now" : "soon")),
    useUiStore.subscribe((s, prev) => s.revision !== prev.revision && ui.changed()),
    useWatchlistStore.subscribe((s, prev) => s.revision !== prev.revision && s.revision !== s.loadedRevision && watchlist.changed()),
  ];
  const savers = { layout, ui, watchlist };
  const all = Object.values(savers);
  const autosave: Autosave = {
    savers,
    retry: () => all.forEach((s) => s.retry()),
    flush: () => all.forEach((s) => s.flush()),
    stop: () => {
      unsubscribe.forEach((u) => u());
      if (active === autosave) active = null;
    },
  };
  active = autosave;
  return autosave;
}
