import type { Screen } from "../../api/generated/Screen";
import type { Screens } from "../../api/generated/Screens";
import { runOf, type ScreenRun } from "../../stores/screener";
import { checkDraft, draftOf, type DraftCheck, type ScreenDraft, withScreen } from "../screen-dialog/screenForm";

export type PutOutcome = { kind: "ok"; saved: Screens } | { kind: "stale"; latest: Screens } | { kind: "error"; message: string };

export interface ScreensPort {
  load(): Promise<Screens>;
  put(screens: Screen[], revision: number): Promise<PutOutcome>;
}

export interface ScreenRunner {
  runs(): Readonly<Record<string, ScreenRun>>;
  run(screen: Screen): Promise<void>;
}

export interface ScreenEntry {
  source: Screen;
  draft?: ScreenDraft;
}

export interface ChosenScreen {
  source: Screen;
  draft?: ScreenDraft;
  dirty: boolean;
  runnable: DraftCheck;
  run: ScreenRun | null;
  saving: boolean;
  tried: boolean;
  nameError: string | null;
  notice: string | null;
}

export interface WorkspaceView {
  entries: readonly ScreenEntry[];
  chosen: ChosenScreen | null;
}

export type RunAttempt = "ran" | "none" | "invalid" | "blocked" | "busy";

export interface Workspace {
  view(): WorkspaceView;
  load(): Promise<void>;
  see(list: Screens): void;
  choose(id: string): void;
  edit(update: (draft: ScreenDraft) => ScreenDraft): void;
  create(copy?: boolean): string | null;
  save(): Promise<void>;
  remove(): Promise<boolean>;
  run(blocked: boolean): Promise<RunAttempt>;
  subscribe(listener: () => void): () => void;
  snapshot(): object;
}

type Saving = { kind: "idle" } | { kind: "saving" } | { kind: "failed"; message: string };

interface Draft {
  source: Screen;
  base: Screens;
  initial: ScreenDraft | null;
  form: ScreenDraft;
  saving: Saving;
  tried: boolean;
}

interface State {
  list: Screens | null;
  chosen: string | null;
  drafts: Readonly<Record<string, Draft>>;
}

type Drafts = State["drafts"];

interface Picked {
  list: Screens;
  source: Screen;
  draft: Draft;
}

const STALE_SAVE = "다른 탭이나 기기에서 조건식 목록이 바뀌어 덮어쓰지 않았습니다. 변경 내용은 유지했습니다. 다시 저장하면 최신 목록에 반영합니다.";
const STALE_DELETE = "다른 탭이나 기기에서 조건식 목록이 바뀌어 삭제하지 않았습니다. 바뀐 목록을 불러왔으니 다시 삭제하세요.";
const failed = (message: string): Saving => ({ kind: "failed", message });

const fresh = (list: Screens, source: Screen): Draft => ({ source, base: list, initial: draftOf(source), form: draftOf(source), saving: { kind: "idle" }, tried: false });
const isDirty = (draft: Draft) => JSON.stringify(draft.form) !== JSON.stringify(draft.initial);
const latest = (list: Screens, draft: Draft) => (draft.base.revision > list.revision ? draft.base : list);

function current(list: Screens, source: Screen, drafts: Drafts): Draft {
  const draft = drafts[source.id];
  if (!draft) return fresh(list, source);
  if (isDirty(draft) || draft.saving.kind === "saving") return draft;
  return { ...fresh(list, source), saving: draft.saving, tried: draft.tried };
}

const sources = (list: Screens, drafts: Drafts): Screen[] => [
  ...list.screens,
  ...Object.values(drafts).filter((draft) => isDirty(draft) && !list.screens.some((screen) => screen.id === draft.source.id)).map((draft) => draft.source),
];

export function createWorkspace({ screens, runner, showsDrafts = () => true }: { screens: ScreensPort; runner: ScreenRunner; showsDrafts?: () => boolean }): Workspace {
  let state: State = { list: null, chosen: null, drafts: {} };
  const listeners = new Set<() => void>();
  const set = (next: State) => {
    state = next;
    for (const listener of listeners) listener();
  };
  const keep = (id: string, draft: Draft) => set({ ...state, drafts: { ...state.drafts, [id]: draft } });
  const see = (list: Screens) => {
    if (!state.list || list.revision > state.list.revision) set({ ...state, list });
  };
  const shownOf = (drafts: Drafts): Drafts => (showsDrafts() ? drafts : {});
  const discard = (id: string) => {
    const drafts = Object.fromEntries(Object.entries(state.drafts).filter(([key]) => key !== id));
    const next = state.list ? sources(state.list, shownOf(drafts))[0] : undefined;
    set({ ...state, drafts, chosen: next?.id ?? null });
  };
  const pick = (): Picked | null => {
    const { list } = state;
    if (!list) return null;
    const all = sources(list, shownOf(state.drafts));
    const source = all.find((screen) => screen.id === state.chosen) ?? all[0];
    return source ? { list, source, draft: current(list, source, state.drafts) } : null;
  };
  const chosenOf = ({ list, source, draft }: Picked): ChosenScreen => {
    if (!showsDrafts()) return { source, dirty: false, runnable: { ok: true, screen: source }, run: runOf(runner.runs(), source), saving: false, tried: false, nameError: null, notice: null };
    const runnable = checkDraft(draft.form, source.id, latest(list, draft).screens);
    const named = draft.tried || draft.form.name !== draft.initial?.name;
    return {
      source,
      draft: draft.form,
      dirty: isDirty(draft),
      runnable,
      run: runnable.ok ? runOf(runner.runs(), runnable.screen) : null,
      saving: draft.saving.kind === "saving",
      tried: draft.tried,
      nameError: !runnable.ok && named ? runnable.errors.name : null,
      notice: draft.saving.kind === "failed" ? draft.saving.message : null,
    };
  };
  return {
    view: () => {
      const { list } = state;
      if (!list) return { entries: [], chosen: null };
      const drafts = shownOf(state.drafts);
      const shown = pick();
      return { entries: sources(list, drafts).map((source) => (showsDrafts() ? { source, draft: current(list, source, drafts).form } : { source })), chosen: shown && chosenOf(shown) };
    },
    load: async () => see(await screens.load()),
    see,
    choose: (id) => set({ ...state, chosen: id }),
    edit: (update) => {
      const shown = pick();
      if (shown && shown.draft.saving.kind !== "saving") keep(shown.source.id, { ...shown.draft, form: update(shown.draft.form) });
    },
    create: (copy = false) => {
      const { list } = state;
      if (!list) return null;
      const id = crypto.randomUUID();
      const source: Screen = { id, name: "새 조건식", conditions: [], markets: [], exclude: [] };
      const from = copy ? pick()?.draft.form : undefined;
      const form = from ? { ...structuredClone(from), name: `${from.name} 복사` } : draftOf(source);
      set({ ...state, chosen: id, drafts: { ...state.drafts, [id]: { ...fresh(list, source), form, initial: null } } });
      return id;
    },
    save: async () => {
      const shown = pick();
      if (!shown || shown.draft.saving.kind === "saving") return;
      const { source, draft } = shown;
      const known = latest(shown.list, draft);
      const checked = checkDraft(draft.form, source.id, known.screens);
      if (!checked.ok) return keep(source.id, { ...draft, tried: true });
      keep(source.id, { ...draft, saving: { kind: "saving" } });
      const outcome = await screens.put(withScreen(known.screens, checked.screen), draft.base.revision + 1);
      if (outcome.kind === "error") return keep(source.id, { ...draft, saving: failed(`저장하지 못했습니다: ${outcome.message}`) });
      if (outcome.kind === "stale") {
        see(outcome.latest);
        return keep(source.id, { ...draft, base: outcome.latest, saving: failed(STALE_SAVE) });
      }
      see(outcome.saved);
      keep(source.id, { ...draft, source: checked.screen, base: state.list ?? outcome.saved, initial: draft.form, saving: { kind: "idle" }, tried: false });
    },
    remove: async () => {
      const shown = pick();
      if (!shown || shown.draft.saving.kind === "saving") return false;
      const { source, draft } = shown;
      if (draft.initial === null) {
        discard(source.id);
        return true;
      }
      const known = latest(shown.list, draft);
      keep(source.id, { ...draft, saving: { kind: "saving" } });
      const outcome = await screens.put(known.screens.filter((screen) => screen.id !== source.id), draft.base.revision + 1);
      if (outcome.kind === "error") {
        keep(source.id, { ...draft, saving: failed(`삭제하지 못했습니다: ${outcome.message}`) });
        return false;
      }
      if (outcome.kind === "stale") {
        see(outcome.latest);
        keep(source.id, { ...draft, base: outcome.latest, saving: failed(STALE_DELETE) });
        return false;
      }
      see(outcome.saved);
      discard(source.id);
      return true;
    },
    run: async (blocked) => {
      const shown = pick();
      if (!shown) return "none";
      const chosen = chosenOf(shown);
      if (!chosen.runnable.ok) {
        keep(shown.source.id, { ...shown.draft, tried: true });
        return "invalid";
      }
      if (blocked) return "blocked";
      if (chosen.run?.kind === "running") return "busy";
      await runner.run(chosen.runnable.screen);
      return "ran";
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    snapshot: () => state,
  };
}
