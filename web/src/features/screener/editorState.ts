import type { QueryClient } from "@tanstack/react-query";
import { create } from "zustand";
import type { Screen } from "../../api/generated/Screen";
import type { Screens } from "../../api/generated/Screens";
import { saveScreens, screensQuery } from "../../api/screener";
import { checkDraft, draftOf, withScreen, type ScreenDraft } from "../screen-dialog/screenForm";

export interface EditorSession {
  source: Screen;
  base: Screens;
  initial: ScreenDraft | null;
  draft: ScreenDraft;
  saving: { kind: "idle" } | { kind: "saving" } | { kind: "failed"; message: string };
  tried: boolean;
}

interface EditorState {
  sessions: Readonly<Record<string, EditorSession>>;
  change(base: Screens, source: Screen, update: (draft: ScreenDraft) => ScreenDraft): void;
  create(base: Screens, copy?: ScreenDraft): string;
  trySubmit(base: Screens, source: Screen): void;
  save(client: QueryClient, base: Screens, source: Screen): Promise<void>;
  remove(client: QueryClient, base: Screens, source: Screen): Promise<boolean>;
}

export const sessionOf = (base: Screens, source: Screen): EditorSession => ({ source, base, initial: draftOf(source), draft: draftOf(source), saving: { kind: "idle" }, tried: false });
export const isDirty = (session: EditorSession) => JSON.stringify(session.draft) !== JSON.stringify(session.initial);
export const checkedSession = (session: EditorSession, latest: Screens) => checkDraft(session.draft, session.source.id, latest.screens);
const reason = (e: unknown) => e instanceof Error ? e.message : String(e);

export function currentSession(base: Screens, source: Screen, sessions: EditorState["sessions"]): EditorSession {
  const session = sessions[source.id];
  if (!session) return sessionOf(base, source);
  if (isDirty(session) || session.saving.kind === "saving") return session;
  return { ...sessionOf(base, source), saving: session.saving, tried: session.tried };
}

export function availableSources(base: Screens, sessions: EditorState["sessions"]): Screen[] {
  return [...base.screens, ...Object.values(sessions).filter((session) => isDirty(session) && !base.screens.some((screen) => screen.id === session.source.id)).map((session) => session.source)];
}

export function selectedSource(base: Screens, id: string | null, sessions: EditorState["sessions"]): Screen | null {
  const sources = availableSources(base, sessions);
  return sources.find((screen) => screen.id === id) ?? sources[0] ?? null;
}

export const useScreenEditor = create<EditorState>()((set, get) => {
  const put = (session: EditorSession) => set((s) => ({ sessions: { ...s.sessions, [session.source.id]: session } }));
  const read = (base: Screens, source: Screen) => currentSession(base, source, get().sessions);
  return {
    sessions: {},
    change: (base, source, update) => {
      const session = read(base, source);
      if (session.saving.kind !== "saving") put({ ...session, draft: update(session.draft) });
    },
    create: (base, copy) => {
      const id = crypto.randomUUID();
      const source: Screen = { id, name: "새 조건식", conditions: [], markets: [], exclude: [] };
      const draft = copy ? { ...structuredClone(copy), name: `${copy.name} 복사` } : draftOf(source);
      put({ ...sessionOf(base, source), draft, initial: null });
      return id;
    },
    trySubmit: (base, source) => put({ ...read(base, source), tried: true }),
    save: async (client, base, source) => {
      const session = read(base, source);
      if (session.saving.kind === "saving") return;
      const checked = checkedSession(session, base);
      if (!checked.ok) return put({ ...session, tried: true });
      put({ ...session, saving: { kind: "saving" } });
      try {
        const outcome = await saveScreens(client, session.base, (list) => withScreen(list, checked.screen));
        if (outcome.kind === "stale") return put({ ...session, base: outcome.latest, saving: { kind: "failed", message: "다른 탭이나 기기에서 조건식 목록이 바뀌어 덮어쓰지 않았습니다. 변경 내용은 유지했습니다. 다시 저장하면 최신 목록에 반영합니다." } });
        const saved = client.getQueryData(screensQuery.queryKey) ?? session.base;
        put({ ...session, source: checked.screen, base: saved, initial: session.draft, saving: { kind: "idle" }, tried: false });
      } catch (e) {
        put({ ...session, saving: { kind: "failed", message: `저장하지 못했습니다: ${reason(e)}` } });
      }
    },
    remove: async (client, base, source) => {
      const session = read(base, source);
      if (session.saving.kind === "saving") return false;
      const discard = () => set((s) => ({ sessions: Object.fromEntries(Object.entries(s.sessions).filter(([id]) => id !== source.id)) }));
      if (session.initial === null) { discard(); return true; }
      put({ ...session, saving: { kind: "saving" } });
      try {
        const outcome = await saveScreens(client, session.base, (list) => list.filter((screen) => screen.id !== source.id));
        if (outcome.kind === "stale") {
          put({ ...session, base: outcome.latest, saving: { kind: "failed", message: "다른 탭이나 기기에서 조건식 목록이 바뀌어 삭제하지 않았습니다. 바뀐 목록을 불러왔으니 다시 삭제하세요." } });
          return false;
        }
        discard();
        return true;
      } catch (e) {
        put({ ...session, saving: { kind: "failed", message: `삭제하지 못했습니다: ${reason(e)}` } });
        return false;
      }
    },
  };
});
