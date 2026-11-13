import type { Revision } from "../../api/generated/Revision";
import type { Screen } from "../../api/generated/Screen";
import type { Screens } from "../../api/generated/Screens";
import { runOf, type ScreenRun } from "../../stores/screener";
import { checkDraft, draftOf, type DraftCheck, type ScreenDraft, withScreen } from "../screen-dialog/screenForm";

export type LoadOutcome = { kind: "ok"; list: Screens } | { kind: "error"; message: string };
export type PutOutcome = { kind: "ok"; saved: Screens } | { kind: "stale"; latest: Screens } | { kind: "error"; message: string };

export interface ScreensPort {
  watch(see: (list: Screens) => void): void;
  load(): Promise<LoadOutcome>;
  put(screens: Screen[], base: Revision): Promise<PutOutcome>;
}

export type RunCheck = { kind: "ready" } | { kind: "blocked" } | { kind: "error"; message: string };
export type Runs = Readonly<Record<string, ScreenRun>>;

export interface ScreenRunner {
  runs(): Runs;
  check(): Promise<RunCheck>;
  run(screen: Screen): Promise<void>;
}

export interface ScreenEntry {
  source: Screen;
  name: string;
  conditions: number;
  dirty: boolean;
}

export interface ChosenScreen {
  source: Screen;
  screen: Screen;
  draft: ScreenDraft;
  stored: boolean;
  dirty: boolean;
  runnable: DraftCheck;
  run: ScreenRun | null;
  saving: boolean;
  tried: boolean;
  nameError: string | null;
  listError: string | null;
  notice: string | null;
}

export interface ScreenEditingView {
  entries: readonly ScreenEntry[];
  chosen: ChosenScreen | null;
}

export type RunOutcome = { kind: "ran" | "none" | "invalid" | "blocked" | "busy" } | { kind: "failed"; message: string };

export interface ScreenEditing {
  view(): ScreenEditingView;
  subscribe(listener: () => void): () => void;
  choose(id: string): void;
  edit(update: (draft: ScreenDraft) => ScreenDraft): void;
  create(copy?: boolean): void;
  save(): Promise<boolean>;
  remove(): Promise<boolean>;
  run(): Promise<RunOutcome>;
}

type Saving = { kind: "idle" } | { kind: "saving" } | { kind: "failed"; message: string };

interface EditState {
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
  edits: Readonly<Record<string, EditState>>;
}

type Edits = State["edits"];

interface Picked {
  list: Screens;
  source: Screen;
  edit: EditState;
}

export const FIX_INVALID = "조건식의 잘못된 값을 고쳐 주세요";
const STALE_SAVE = "다른 탭이나 기기에서 조건식 목록이 바뀌어 덮어쓰지 않았습니다. 변경 내용은 유지했습니다. 다시 저장하면 최신 목록에 반영합니다.";
const STALE_DELETE = "다른 탭이나 기기에서 조건식 목록이 바뀌어 삭제하지 않았습니다. 바뀐 목록을 불러왔으니 다시 삭제하세요.";
const failed = (message: string): Saving => ({ kind: "failed", message });
const reason = (e: unknown) => (e instanceof Error ? e.message : String(e));

const fresh = (list: Screens, source: Screen): EditState => ({ source, base: list, initial: draftOf(source), form: draftOf(source), saving: { kind: "idle" }, tried: false });
const isDirty = (edit: EditState) => JSON.stringify(edit.form) !== JSON.stringify(edit.initial);
const latest = (list: Screens, edit: EditState) => (edit.base.revision > list.revision ? edit.base : list);

function current(list: Screens, source: Screen, edits: Edits): EditState {
  const edit = edits[source.id];
  if (!edit) return fresh(list, source);
  if (isDirty(edit) || edit.saving.kind === "saving") return edit;
  return { ...fresh(list, source), saving: edit.saving, tried: edit.tried };
}

const sources = (list: Screens, edits: Edits): Screen[] => [
  ...list.screens,
  ...Object.values(edits).filter((edit) => isDirty(edit) && !list.screens.some((screen) => screen.id === edit.source.id)).map((edit) => edit.source),
];

export function createScreenEditing({ screens, runner }: { screens: ScreensPort; runner: ScreenRunner }): ScreenEditing {
  let state: State = { list: null, chosen: null, edits: {} };
  let shown: { state: State; runs: Runs; view: ScreenEditingView } | null = null;
  const listeners = new Set<() => void>();
  const set = (next: State) => {
    state = next;
    for (const listener of listeners) listener();
  };
  const keep = (id: string, edit: EditState) => set({ ...state, edits: { ...state.edits, [id]: edit } });
  const see = (list: Screens) => {
    if (!state.list || list.revision > state.list.revision) set({ ...state, list });
  };
  const discard = (id: string) => {
    const edits = Object.fromEntries(Object.entries(state.edits).filter(([key]) => key !== id));
    const next = state.list ? sources(state.list, edits)[0] : undefined;
    set({ ...state, edits, chosen: next?.id ?? null });
  };
  const pick = (): Picked | null => {
    const { list } = state;
    if (!list) return null;
    const all = sources(list, state.edits);
    const source = all.find((screen) => screen.id === state.chosen) ?? all[0];
    return source ? { list, source, edit: current(list, source, state.edits) } : null;
  };
  const chosenOf = ({ list, source, edit }: Picked, runs: Runs): ChosenScreen => {
    const runnable = checkDraft(edit.form, source.id, latest(list, edit).screens);
    const named = edit.tried || edit.form.name !== edit.initial?.name;
    return {
      source,
      screen: runnable.ok ? runnable.screen : source,
      draft: edit.form,
      stored: list.screens.some((screen) => screen.id === source.id),
      dirty: isDirty(edit),
      runnable,
      run: runnable.ok ? runOf(runs, runnable.screen) : null,
      saving: edit.saving.kind === "saving",
      tried: edit.tried,
      nameError: !runnable.ok && named ? runnable.errors.name : null,
      listError: !runnable.ok && edit.tried ? runnable.errors.list ?? null : null,
      notice: edit.saving.kind === "failed" ? edit.saving.message : null,
    };
  };
  const viewOf = (runs: Runs): ScreenEditingView => {
    const { list } = state;
    if (!list) return { entries: [], chosen: null };
    const entries = sources(list, state.edits).map((source): ScreenEntry => {
      const edit = current(list, source, state.edits);
      return { source, name: edit.form.name, conditions: edit.form.conditions.length, dirty: isDirty(edit) };
    });
    const picked = pick();
    return { entries, chosen: picked && chosenOf(picked, runs) };
  };
  const invalid = (picked: Picked, runs: Runs) => {
    if (chosenOf(picked, runs).runnable.ok) return false;
    keep(picked.source.id, { ...picked.edit, tried: true });
    return true;
  };
  screens.watch(see);
  return {
    view: () => {
      const runs = runner.runs();
      if (shown?.state !== state || shown.runs !== runs) shown = { state, runs, view: viewOf(runs) };
      return shown.view;
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    choose: (id) => set({ ...state, chosen: id }),
    edit: (update) => {
      const picked = pick();
      if (picked && picked.edit.saving.kind !== "saving") keep(picked.source.id, { ...picked.edit, form: update(picked.edit.form) });
    },
    create: (copy = false) => {
      const { list } = state;
      if (!list) return;
      const id = crypto.randomUUID();
      const source: Screen = { id, name: "새 조건식", conditions: [], markets: [], exclude: [] };
      const from = copy ? pick()?.edit.form : undefined;
      const form = from ? { ...structuredClone(from), name: `${from.name} 복사` } : draftOf(source);
      set({ ...state, chosen: id, edits: { ...state.edits, [id]: { ...fresh(list, source), form, initial: null } } });
    },
    save: async () => {
      const picked = pick();
      if (!picked || picked.edit.saving.kind === "saving" || !isDirty(picked.edit)) return false;
      const { source, edit } = picked;
      const known = latest(picked.list, edit);
      const checked = checkDraft(edit.form, source.id, known.screens);
      if (!checked.ok) {
        keep(source.id, { ...edit, tried: true });
        return false;
      }
      keep(source.id, { ...edit, saving: { kind: "saving" } });
      const outcome = await screens.put(withScreen(known.screens, checked.screen), edit.base.revision);
      if (outcome.kind === "error") {
        keep(source.id, { ...edit, saving: failed(`저장하지 못했습니다: ${outcome.message}`) });
        return false;
      }
      if (outcome.kind === "stale") {
        see(outcome.latest);
        keep(source.id, { ...edit, base: outcome.latest, saving: failed(STALE_SAVE) });
        return false;
      }
      see(outcome.saved);
      keep(source.id, { ...edit, source: checked.screen, base: state.list ?? outcome.saved, initial: edit.form, saving: { kind: "idle" }, tried: false });
      return true;
    },
    remove: async () => {
      const picked = pick();
      if (!picked || picked.edit.saving.kind === "saving") return false;
      const { source, edit } = picked;
      if (edit.initial === null) {
        discard(source.id);
        return true;
      }
      const known = latest(picked.list, edit);
      keep(source.id, { ...edit, saving: { kind: "saving" } });
      const outcome = await screens.put(known.screens.filter((screen) => screen.id !== source.id), edit.base.revision);
      if (outcome.kind === "error") {
        keep(source.id, { ...edit, saving: failed(`삭제하지 못했습니다: ${outcome.message}`) });
        return false;
      }
      if (outcome.kind === "stale") {
        see(outcome.latest);
        keep(source.id, { ...edit, base: outcome.latest, saving: failed(STALE_DELETE) });
        return false;
      }
      see(outcome.saved);
      discard(source.id);
      return true;
    },
    run: async () => {
      const before = pick();
      if (before && invalid(before, runner.runs())) return { kind: "invalid" };
      const [loaded, check] = await Promise.all([screens.load(), runner.check()]);
      if (loaded.kind === "error") return { kind: "failed", message: loaded.message };
      see(loaded.list);
      const picked = pick();
      if (!picked) return { kind: "none" };
      const runs = runner.runs();
      if (invalid(picked, runs)) return { kind: "invalid" };
      if (check.kind === "error") return { kind: "failed", message: check.message };
      if (check.kind === "blocked") return { kind: "blocked" };
      const chosen = chosenOf(picked, runs);
      if (chosen.run?.kind === "running") return { kind: "busy" };
      try {
        await runner.run(chosen.screen);
        return { kind: "ran" };
      } catch (e) {
        return { kind: "failed", message: reason(e) };
      }
    },
  };
}
