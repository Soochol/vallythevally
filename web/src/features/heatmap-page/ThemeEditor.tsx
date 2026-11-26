import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { HeatmapTheme } from "../../api/generated/HeatmapTheme";
import type { HeatmapThemes } from "../../api/generated/HeatmapThemes";
import type { SymbolCode } from "../../api/generated/SymbolCode";
import { fetchLatestThemes, isStaleRevision, saveHeatmapThemes } from "../../api/heatmapThemes";
import { ApiRequestError } from "../../api/http";
import { useSymbolInfos } from "../../api/queries";
import {
  addSymbolToTheme,
  createTheme,
  deleteTheme,
  importNotices,
  importWatchlistGroups,
  MAX_THEME_NAME_CHARS,
  MAX_THEME_SYMBOLS,
  MAX_THEMES,
  moveItem,
  moveSymbol,
  removeSymbolFromTheme,
  renameTheme,
  sameThemes,
  themesProblem,
  transferSymbol,
} from "../../lib/heatmapThemes";
import { useSelectionStore } from "../../stores/selection";
import { useWatchlistStore } from "../../stores/watchlist";
import { Skeleton } from "../overlay/State";
import { type BoardDrag, ThemeColumn } from "./ThemeColumn";

export type ThemeEditorStart = "browse" | "import" | "create";

interface Props {
  start: ThemeEditorStart;
  names: ReadonlyMap<SymbolCode, string>;
  rates: ReadonlyMap<SymbolCode, number | null>;
  onClose(): void;
}

type Loaded = { kind: "loading" } | { kind: "failed"; message: string } | { kind: "ready"; base: HeatmapThemes };
type SaveFailure = { message: string; stale: boolean };

const errorText = (error: unknown) => (error instanceof ApiRequestError ? error.message : "알 수 없는 오류가 났습니다");

export function ThemeEditor({ start, names: boardNames, rates, onClose }: Props) {
  const client = useQueryClient();
  const lists = useWatchlistStore((s) => s.lists);
  const [loaded, setLoaded] = useState<Loaded>({ kind: "loading" });
  const [draft, setDraft] = useState<HeatmapTheme[]>([]);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [importing, setImporting] = useState(start === "import");
  const [notices, setNotices] = useState<string[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<SaveFailure | null>(null);
  const [newNameText, setNewNameText] = useState("");
  const [searchedNames, setSearchedNames] = useState<ReadonlyMap<SymbolCode, string>>(new Map());
  const dragRef = useRef<BoardDrag | null>(null);
  const cancelledRename = useRef(false);
  const newNameInput = useRef<HTMLInputElement>(null);

  const load = useCallback(() => {
    setLoaded({ kind: "loading" });
    fetchLatestThemes(client).then(
      (base) => {
        setLoaded({ kind: "ready", base });
        setDraft(base.themes);
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

  useEffect(() => {
    if (base !== null && start === "create") newNameInput.current?.focus();
  }, [base, start]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || event.key !== "Escape") return;
      if (event.target instanceof Element && event.target.closest(".hm-edit-col-add[data-search-open]")) return;
      if (renamingId !== null) {
        event.preventDefault();
        cancelledRename.current = true;
        setRenamingId(null);
        return;
      }
      if (deletingId !== null) {
        event.preventDefault();
        setDeletingId(null);
        return;
      }
      if (importing) {
        event.preventDefault();
        setImporting(false);
        return;
      }
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [renamingId, deletingId, importing, onClose]);

  const allCodes = useMemo(() => [...new Set(draft.flatMap((theme) => theme.symbols))], [draft]);
  const infos = useSymbolInfos(allCodes);
  const nameMap = useMemo(() => {
    const merged = new Map(boardNames);
    for (const info of infos) merged.set(info.code, info.name);
    for (const [code, name] of searchedNames) merged.set(code, name);
    return merged;
  }, [boardNames, infos, searchedNames]);

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
    return true;
  };

  const commitRename = (id: string, name: string) => {
    setRenamingId(null);
    if (cancelledRename.current) {
      cancelledRename.current = false;
      return;
    }
    const result = renameTheme(draft, id, name);
    if (result.ok) edit(result.themes);
    else setProblem(result.problem);
  };

  const remove = (id: string) => {
    edit(deleteTheme(draft, id));
    setDeletingId(null);
  };

  const moveThemeById = (fromId: string, toSlot: number) => {
    const from = draft.findIndex((theme) => theme.id === fromId);
    if (from < 0) return;
    const to = toSlot > from ? toSlot - 1 : toSlot;
    edit(moveItem(draft, from, to));
  };

  const addSymbol = (themeId: string, code: SymbolCode, name: string) => {
    const result = addSymbolToTheme(draft, themeId, code);
    if (result.outcome !== "added") return;
    edit(result.themes);
    setSearchedNames((current) => new Map(current).set(code, name));
  };

  const handleTransfer = (fromId: string, toId: string, code: SymbolCode, copy: boolean, toIndex?: number) => {
    const result = transferSymbol(draft, fromId, toId, code, { copy, toIndex });
    if (result.outcome === "added") {
      edit(result.themes);
      return;
    }
    const targetName = draft.find((theme) => theme.id === toId)?.name ?? "";
    if (result.outcome === "duplicate") setProblem(`‘${targetName}’ 테마에 이미 있는 종목입니다`);
    else if (result.outcome === "full") setProblem(`‘${targetName}’ 테마는 종목이 ${MAX_THEME_SYMBOLS}개라 더 넣을 수 없습니다`);
  };

  const importFrom = (listId: string) => {
    const list = lists.find((candidate) => candidate.id === listId);
    if (!list) return;
    const { themes, report } = importWatchlistGroups(draft, list, () => crypto.randomUUID());
    setNotices(importNotices(list.name, list.groups.length, report));
    setImporting(false);
    if (report.imported.length === 0) return;
    edit(themes);
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

  const statusText = problem ?? failure?.message ?? (dirty ? "저장하지 않은 변경이 있습니다" : "바꾼 내용이 없습니다");
  const statusIsAlert = problem !== null || failure !== null;

  return (
    <section className="hm-edit-sheet" aria-labelledby="hm-edit-title">
      <div className="hm-edit-bar">
        <div className="hm-edit-bar-lead">
          <h2 id="hm-edit-title">테마 편집</h2>
          <span className="hm-edit-total">{draft.length} / {MAX_THEMES}</span>
          <p className="hm-edit-msg" data-tone={statusIsAlert ? "error" : dirty ? "dirty" : undefined} role={statusIsAlert ? "alert" : "status"}>
            {statusText}
          </p>
        </div>
        <div className="hm-edit-bar-actions">
          {base !== null && (
            <button
              type="button"
              className="btn btn-sm"
              aria-expanded={importing}
              onClick={() => {
                setImporting((open) => !open);
                setNotices([]);
              }}
            >
              관심종목 그룹에서 가져오기
            </button>
          )}
          {failure?.stale && (
            <button type="button" className="btn btn-sm" onClick={load}>
              최신 문서 다시 받기
            </button>
          )}
          {dirty && base !== null && (
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => {
                edit(base.themes);
                setRenamingId(null);
                setDeletingId(null);
              }}
            >
              되돌리기
            </button>
          )}
          <button type="button" className="btn btn-sm" onClick={onClose}>
            취소
          </button>
          <button type="button" className="btn-primary btn-sm" disabled={!dirty || saving} onClick={() => void save()}>
            {saving ? "저장하는 중" : "저장"}
          </button>
        </div>
      </div>

      {failure?.stale && (
        <p className="hm-edit-band">
          다른 곳에서 먼저 저장한 테마와 겹쳐 저장하지 못했습니다. 최신 문서를 다시 받으면 지금 편집한 내용이 사라지고 다른 곳의 변경이 남습니다.
        </p>
      )}

      {importing && base !== null && (
        <div className="hm-edit-import-bar" role="group" aria-label="관심종목 그룹에서 가져오기">
          <div className="hm-edit-import-head">
            <b>관심종목 그룹에서 가져오기</b>
            <span>목록 하나를 고르면 그룹이 같은 이름·순서의 테마로 추가됩니다. 관심종목은 바뀌지 않습니다.</span>
          </div>
          <div className="hm-edit-import-lists">
            {lists.map((list) => (
              <button key={list.id} type="button" className="btn btn-sm" onClick={() => importFrom(list.id)}>
                {list.name} · 그룹 {list.groups.length}개
              </button>
            ))}
            <button type="button" className="hm-edit-small" onClick={() => setImporting(false)}>
              닫기
            </button>
          </div>
        </div>
      )}

      {notices.length > 0 && (
        <ul className="hm-edit-notices" role="status" aria-label="가져오기 결과">
          {notices.map((notice) => (
            <li key={notice}>{notice}</li>
          ))}
        </ul>
      )}

      {loaded.kind === "loading" && (
        <div className="hm-edit-state">
          <Skeleton label="테마를 불러오는 중" />
        </div>
      )}

      {loaded.kind === "failed" && (
        <div className="hm-edit-state" role="alert">
          <p>테마를 불러오지 못했습니다: {loaded.message}</p>
          <button type="button" className="btn btn-sm" onClick={load}>
            다시 시도
          </button>
        </div>
      )}

      {base !== null && (
        <div className="hm-edit-grid-wrap">
          <p className="hm-edit-hint">종목을 다른 테마 열로 끌어 이동 (Shift+드래그 복제) · 열 머리 드래그로 순서 변경 · 테마 이름을 눌러 수정</p>
          <div className="hm-edit-grid">
            {draft.map((theme, index) => (
              <ThemeColumn
                key={theme.id}
                theme={theme}
                index={index}
                renaming={renamingId === theme.id}
                deleting={deletingId === theme.id}
                names={nameMap}
                rates={rates}
                dragRef={dragRef}
                onStartRename={() => {
                  cancelledRename.current = false;
                  setRenamingId(theme.id);
                  setDeletingId(null);
                }}
                onCommitRename={(name) => commitRename(theme.id, name)}
                onAskDelete={() => setDeletingId(theme.id)}
                onCancelDelete={() => setDeletingId(null)}
                onDelete={() => remove(theme.id)}
                onAddSymbol={(code, name) => addSymbol(theme.id, code, name)}
                onRemoveSymbol={(code) => edit(removeSymbolFromTheme(draft, theme.id, code))}
                onMoveTheme={moveThemeById}
                onMoveSymbol={(from, to) => edit(moveSymbol(draft, theme.id, from, to))}
                onTransferSymbol={(fromId, code, copy, toIndex) => handleTransfer(fromId, theme.id, code, copy, toIndex)}
              />
            ))}

            <form
              className="hm-edit-new-col"
              onSubmit={(event) => {
                event.preventDefault();
                if (create(newNameText.trim())) setNewNameText("");
              }}
            >
              <input
                ref={newNameInput}
                className="ui-field hm-edit-new-input"
                aria-label="새 테마 이름"
                placeholder={`+ 새 테마 이름 (${MAX_THEME_NAME_CHARS}자까지)`}
                value={newNameText}
                autoComplete="off"
                onChange={(event) => setNewNameText(event.target.value)}
              />
              <button type="submit" className="btn btn-sm">
                테마 추가
              </button>
            </form>
          </div>
        </div>
      )}
    </section>
  );
}
