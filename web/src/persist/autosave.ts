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
import { toWireWindow } from "./layoutWire";
import { toUiState } from "./uiState";
import type { LayoutReceiptRecorder, ReceiptSession } from "./layoutReceipt";

const DEBOUNCE_MS = 1000;
export const RECENT_CLEARED = "최근 본 종목 기록을 지웠습니다";

export interface AutosaveDeps {
  put(path: string, json: string, opts: { keepalive: boolean }): Promise<unknown>;
  toast(text: string): void;
  revisions: Record<SaveTarget, number>;
  serverCharts?: readonly string[];
  receipt: LayoutReceiptRecorder;
  unsaved?: (target: SaveTarget) => SaverOptions<object>["unsaved"];
}

type WatchlistsBody = Omit<Watchlists, "revision">;

export interface Autosave {
  savers: { layout: Saver<Omit<LayoutInput, "revision">>; ui: Saver<Omit<UiState, "revision">>; watchlist: Saver<WatchlistsBody> };
  retry(): void;
  flush(): void;
  stop(): void;
  replaceLayout(layout: EditableLayout, revision: number, serverCharts: readonly string[]): void;
}

let active: Autosave | null = null;
interface LayoutSession {
  current: EditableLayout;
  saver: Saver<Omit<LayoutInput, "revision">>;
  owned: boolean;
  receipt: ReceiptSession;
}

function layoutSent(json: string): { revision: number; charts: ReadonlySet<string> } {
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

  function createLayoutSession(current: EditableLayout, revision: number, serverCharts?: readonly string[]): LayoutSession {
    const path = layoutPath(current.id);
    const drafts = deps.unsaved ? unsaved("layout") : { write: (u: Parameters<typeof writeUnsaved>[1]) => writeUnsaved("layout", u), clear: (upTo: number) => clearUnsaved("layout", upTo, path) };
    let shown = current;
    const receipt = deps.receipt.begin(() => shown, serverCharts);
    const owner: LayoutSession = {
      get current() { return shown; },
      set current(next) { shown = next; },
      owned: true,
      receipt,
      saver: createSaver<Omit<LayoutInput, "revision">>({
        debounceMs: DEBOUNCE_MS,
        read: () => {
          const { id, name, sync, windows, placement } = owner.current;
          return { id, name, sync, windows: windows.map(toWireWindow), placement };
        },
        tooLarge: exceedsServerFieldLimits,
        path: () => path,
        revision,
        acceptStaleRevision: false,
        send: async (path, json, opts) => {
          const { revision, charts } = layoutSent(json);
          const sending = receipt.send(revision, charts);
          try {
            const saved = await deps.put(path, json, opts);
            sending.saved();
            return saved;
          } catch (e) {
            sending.unsure(e instanceof ApiRequestError && e.code === "stale_revision");
            throw e;
          }
        },
        unsaved: drafts && { write: (u) => { if (owner.owned) drafts.write(u); }, clear: (upTo) => { if (owner.owned) drafts.clear(upTo); } },
        onState: (s) => { if (owner.owned) { setSave("layout", s); receipt.state(s); } },
      }),
    };
    return owner;
  }
  let layoutSession = createLayoutSession(useLayoutStore.getState().layout, deps.revisions.layout, deps.serverCharts);

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
    useLayoutStore.subscribe((s, prev) => {
      if (s.layout.id !== layoutSession.current.id) return;
      layoutSession.current = s.layout;
      if (s.revision !== prev.revision) layoutSession.saver.changed(addsChartWindow(prev.layout, s.layout) ? "now" : "soon");
    }),
    useUiStore.subscribe((s, prev) => s.revision !== prev.revision && ui.changed()),
    useWatchlistStore.subscribe((s, prev) => s.revision !== prev.revision && s.revision !== s.loadedRevision && watchlist.changed()),
  ];
  const savers = { get layout() { return layoutSession.saver; }, ui, watchlist };
  const all = () => Object.values(savers);
  const autosave: Autosave = {
    savers,
    replaceLayout(layout, revision, serverCharts) {
      layoutSession.owned = false;
      void layoutSession.saver.stop();
      layoutSession = createLayoutSession(layout, revision, serverCharts);
      setSave("layout", { kind: "idle" });
    },
    retry: () => all().forEach((s) => s.retry()),
    flush: () => all().forEach((s) => s.flush()),
    stop: () => {
      unsubscribe.forEach((u) => u());
      layoutSession.owned = false;
      layoutSession.receipt.end();
      all().forEach((s) => { void s.stop(); });
      if (active === autosave) active = null;
    },
  };
  active = autosave;
  return autosave;
}

export async function saveAllAndWait(): Promise<void> {
  if (!active) return;
  await Promise.all(Object.values(active.savers).map((saver) => saver.save()));
}

export function layoutAutosave(): Autosave {
  if (!active) throw new Error("레이아웃 저장이 시작되지 않았습니다");
  return active;
}
