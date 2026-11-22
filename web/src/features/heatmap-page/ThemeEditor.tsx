import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import type { HeatmapTheme } from "../../api/generated/HeatmapTheme";
import type { HeatmapThemes } from "../../api/generated/HeatmapThemes";
import type { SymbolCode } from "../../api/generated/SymbolCode";
import { fetchLatestThemes, isStaleRevision, saveHeatmapThemes } from "../../api/heatmapThemes";
import { ApiRequestError } from "../../api/http";
import {
  addSymbolToTheme,
  createTheme,
  deleteTheme,
  importNotices,
  importWatchlistGroups,
  moveItem,
  moveSymbol,
  removeSymbolFromTheme,
  renameTheme,
  sameThemes,
  themesProblem,
} from "../../lib/heatmapThemes";
import { useSelectionStore } from "../../stores/selection";
import { useWatchlistStore } from "../../stores/watchlist";
import { DialogFrame } from "../dialog/DialogParts";
import { CloseIcon } from "../icons";
import { Skeleton } from "../overlay/State";
import { MemberPane } from "./MemberPane";
import { ThemeListPane } from "./ThemeListPane";

export type ThemeEditorStart = "browse" | "import" | "create";

interface Props {
  start: ThemeEditorStart;
  onClose(): void;
}

type Loaded = { kind: "loading" } | { kind: "failed"; message: string } | { kind: "ready"; base: HeatmapThemes };
type SaveFailure = { message: string; stale: boolean };

const errorText = (error: unknown) => (error instanceof ApiRequestError ? error.message : "알 수 없는 오류가 났습니다");

export function ThemeEditor({ start, onClose }: Props) {
  const client = useQueryClient();
  const lists = useWatchlistStore((s) => s.lists);
  const [loaded, setLoaded] = useState<Loaded>({ kind: "loading" });
  const [draft, setDraft] = useState<HeatmapTheme[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [importing, setImporting] = useState(start === "import");
  const [notices, setNotices] = useState<string[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<SaveFailure | null>(null);
  const [searchedNames, setSearchedNames] = useState<ReadonlyMap<SymbolCode, string>>(new Map());
  const dismissRename = useRef<() => boolean>(() => false);

  const load = useCallback(() => {
    setLoaded({ kind: "loading" });
    fetchLatestThemes(client).then(
      (base) => {
        setLoaded({ kind: "ready", base });
        setDraft(base.themes);
        setSelectedId(base.themes[0]?.id ?? null);
        setRenamingId(null);
        setDeletingId(null);
        setFailure(null);
        setProblem(null);
      },
      (error: unknown) => setLoaded({ kind: "failed", message: errorText(error) }),
    );
  }, [client]);
  useEffect(load, [load]);

  const base = loaded.kind === "ready" ? loaded.base : null;
  const dirty = base !== null && !sameThemes(draft, base.themes);
  const selected = draft.find((theme) => theme.id === selectedId) ?? null;

  const edit = (next: HeatmapTheme[]) => {
    setDraft(next);
    setProblem(null);
    setFailure(null);
  };

  const create = (name: string): boolean => {
    const id = crypto.randomUUID();
    const result = createTheme(draft, id, name);
    if (!result.ok) {
      setProblem(result.problem);
      return false;
    }
    edit(result.themes);
    setSelectedId(id);
    return true;
  };

  const rename = (id: string, name: string) => {
    const result = renameTheme(draft, id, name);
    if (result.ok) edit(result.themes);
    else setProblem(result.problem);
  };

  const remove = (id: string) => {
    const next = deleteTheme(draft, id);
    edit(next);
    setDeletingId(null);
    if (selectedId === id) setSelectedId(next[0]?.id ?? null);
  };

  const moveTheme = (from: number, to: number) => edit(moveItem(draft, from, to));

  const addSymbol = (code: SymbolCode, name: string) => {
    if (selected === null) return;
    const result = addSymbolToTheme(draft, selected.id, code);
    if (result.outcome !== "added") return;
    edit(result.themes);
    setSearchedNames((names) => new Map(names).set(code, name));
  };

  const importFrom = (listId: string) => {
    const list = lists.find((candidate) => candidate.id === listId);
    if (!list) return;
    const { themes, report } = importWatchlistGroups(draft, list, () => crypto.randomUUID());
    setNotices(importNotices(list.name, list.groups.length, report));
    setImporting(false);
    if (report.imported.length === 0) return;
    edit(themes);
    setSelectedId(themes.find((theme) => theme.name === report.imported[0])?.id ?? selectedId);
  };

  const save = async () => {
    if (base === null) return;
    const invalid = themesProblem(draft);
    if (invalid !== null) {
      setProblem(invalid);
      return;
    }
    setSaving(true);
    setFailure(null);
    try {
      await saveHeatmapThemes(client, draft, base.revision);
      useSelectionStore.getState().showToast("테마를 저장했습니다");
      onClose();
    } catch (error) {
      setFailure(
        isStaleRevision(error)
          ? { message: "다른 곳에서 테마가 먼저 바뀌어 저장하지 못했습니다. 최신 문서를 다시 받아야 합니다. 지금 편집한 내용은 그대로 남아 있습니다.", stale: true }
          : { message: `저장하지 못했습니다: ${errorText(error)}`, stale: false },
      );
    } finally {
      setSaving(false);
    }
  };

  const close = (reason?: "escape" | "outside") => {
    if (reason === "escape" && (dismissRename.current() || deletingId !== null)) {
      setDeletingId(null);
      return;
    }
    if (reason === "outside" && dirty) return;
    onClose();
  };

  const footerText = problem ?? failure?.message ?? (dirty ? "저장하지 않은 변경이 있습니다" : "바꾼 내용이 없습니다");
  const footerIsAlert = problem !== null || failure !== null;

  return (
    <DialogFrame variant="drawer" labelledBy="hm-edit-title" width="w-[min(900px,100vw)]" onClose={close}>
      <div className="ui-dialog-head hm-edit-head">
        <h2 id="hm-edit-title" className="flex-none text-l font-[650]">테마 편집</h2>
        <p className="min-w-0 flex-1">저장을 눌러야 히트맵에 반영됩니다. 테마는 관심종목과 따로 서버에 저장됩니다.</p>
        <button type="button" className="icon-btn ml-auto flex-none" aria-label="닫기" title="닫기 (Esc)" onClick={onClose}>
          <CloseIcon />
        </button>
      </div>
      {loaded.kind === "loading" && <div className="hm-edit-state"><Skeleton label="테마를 불러오는 중" /></div>}
      {loaded.kind === "failed" && (
        <div className="hm-edit-state" role="alert">
          <p>테마를 불러오지 못했습니다: {loaded.message}</p>
          <button type="button" className="tb-btn" onClick={load}>다시 시도</button>
        </div>
      )}
      {base !== null && (
        <div className="hm-edit-body">
          <ThemeListPane
            themes={draft}
            selectedId={selectedId}
            renamingId={renamingId}
            deletingId={deletingId}
            importing={importing}
            focusNewName={start === "create"}
            lists={lists}
            notices={notices}
            dismissRename={dismissRename}
            onSelect={(id) => { setSelectedId(id); setDeletingId(null); }}
            onCreate={create}
            onStartRename={(id) => { setRenamingId(id); setDeletingId(null); }}
            onCommitRename={(id, name) => { setRenamingId(null); rename(id, name); }}
            onCancelRename={() => setRenamingId(null)}
            onAskDelete={setDeletingId}
            onCancelDelete={() => setDeletingId(null)}
            onDelete={remove}
            onMove={moveTheme}
            onToggleImport={() => { setImporting((on) => !on); setNotices([]); }}
            onImport={importFrom}
          />
          <MemberPane
            theme={selected}
            searchedNames={searchedNames}
            onAdd={addSymbol}
            onRemove={(code) => selected && edit(removeSymbolFromTheme(draft, selected.id, code))}
            onMove={(from, to) => selected && edit(moveSymbol(draft, selected.id, from, to))}
          />
        </div>
      )}
      <div className="ui-dialog-foot hm-edit-foot">
        <p className="hm-edit-msg" data-tone={footerIsAlert ? "error" : undefined} role={footerIsAlert ? "alert" : "status"}>{footerText}</p>
        {failure?.stale && <button type="button" className="tb-btn" onClick={load}>최신 문서 다시 받기</button>}
        <button type="button" className="tb-btn" onClick={onClose}>취소</button>
        <button type="button" className="btn-primary" disabled={!dirty || saving} onClick={() => void save()}>{saving ? "저장하는 중" : "저장"}</button>
      </div>
    </DialogFrame>
  );
}
