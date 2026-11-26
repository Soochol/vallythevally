import { type DragEvent, memo, type RefObject, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { SymbolCode } from "../../api/generated/SymbolCode";
import type { SymbolInfo } from "../../api/generated/SymbolInfo";
import { useSymbolSearch } from "../../api/queries";
import { formatPercent, formatPrice } from "../../lib/format";
import { rateSide } from "../../lib/heat/colors";
import { MAX_THEME_SYMBOLS } from "../../lib/heatmapThemes";
import { isIndexCode } from "../../lib/symbol";
import { quoteBook } from "../../stores/realtime";
import { ChevronIcon, CloseIcon, GripIcon, PenIcon, PlusIcon } from "../icons";
import { EmptyState } from "../overlay/State";
import { useSendSymbol } from "../pages/sendSymbol";
import { boardRows, sortRows, type SnapshotRow } from "./arrange";
import { tradedText } from "./HeatmapGroup";
import type { HeatmapSection } from "./HeatmapPage";
import type { HeatmapSettings } from "./settings";
import { rateIntensityLevel } from "./themeInlineEdit";
import { TileMenu, type TileMenuState } from "./TileMenu";
import { addToActiveWatchlist, type ThemeChoice } from "./themeQuickEdit";
import type { InlineEditActions } from "./useHeatmapInlineEdit";

const SEARCH_RESULT_LIMIT = 8;

type ListDrag =
  | { kind: "group"; themeId: string }
  | { kind: "stock"; fromThemeId: string; code: SymbolCode };

interface ListProps {
  sections: readonly HeatmapSection[];
  settings: HeatmapSettings;
  names: ReadonlyMap<SymbolCode, string>;
  themes: readonly ThemeChoice[];
  query: string;
  edit: InlineEditActions;
}

interface RowProps {
  themeId: string;
  row: SnapshotRow;
  dndEnabled: boolean;
  customSort: boolean;
  dragRef: RefObject<ListDrag | null>;
  dropMark: "before" | "after" | undefined;
  onRowMark(code: SymbolCode, mark: "before" | "after" | null): void;
  onStockGroupDrop(mode: "move" | "copy"): void;
  onClearMarks(): void;
  onSend(row: SnapshotRow): void;
  onMenu(code: SymbolCode, x: number, y: number): void;
  onRemove(code: SymbolCode, name: string): void;
  onReorderSymbol(code: SymbolCode, targetCode: SymbolCode, after: boolean): void;
  onTransferStock(fromId: string, code: SymbolCode, copy: boolean, targetCode: SymbolCode, after: boolean): void;
}

const lowerHalf = (event: DragEvent<HTMLElement>) => {
  const box = event.currentTarget.getBoundingClientRect();
  return event.clientY > box.top + box.height / 2;
};

const rightHalf = (event: DragEvent<HTMLElement>) => {
  const box = event.currentTarget.getBoundingClientRect();
  return event.clientX > box.left + box.width / 2;
};

function useLiveRowQuote(code: SymbolCode, fallbackRate: number | null) {
  const subscribe = useMemo(() => (listener: () => void) => quoteBook.subscribe(code, listener), [code]);
  const live = useSyncExternalStore(subscribe, () => quoteBook.get(code));
  return {
    price: live.quote?.price ?? null,
    rate: live.quote?.changeRate ?? fallbackRate,
    expected: live.quote?.source === "expected",
  };
}

const ListRow = memo(function ListRow({
  themeId,
  row,
  dndEnabled,
  customSort,
  dragRef,
  dropMark,
  onRowMark,
  onStockGroupDrop,
  onClearMarks,
  onSend,
  onMenu,
  onRemove,
  onReorderSymbol,
  onTransferStock,
}: RowProps) {
  const { price, rate, expected } = useLiveRowQuote(row.code, row.changeRate);
  const [dragging, setDragging] = useState(false);
  const rateText = rate === null ? "–" : formatPercent(rate);
  const priceText = price === null ? "–" : formatPrice(price, false);
  const traded = row.tradedMillionWon === null ? "–" : tradedText(row.tradedMillionWon);
  const side = rate === null ? "none" : rateSide(rate);

  return (
    <li className="hm-list-item" data-drop-row={dropMark}>
      <div
        role="button"
        tabIndex={0}
        draggable
        className="hm-list-row"
        data-code={row.code}
        data-side={side}
        data-dragging={dragging ? "" : undefined}
        aria-label={expected ? `${row.name} ${priceText} ${rateText} 예상체결` : `${row.name} ${priceText} ${rateText}`}
        aria-haspopup="menu"
        aria-keyshortcuts="Shift+F10"
        onClick={(event) => {
          if ((event.target as Element).closest(".hm-list-rm")) return;
          onSend(row);
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          onMenu(row.code, event.clientX, event.clientY);
        }}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onSend(row);
            return;
          }
          if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
          event.preventDefault();
          const box = event.currentTarget.getBoundingClientRect();
          onMenu(row.code, box.x, box.bottom);
        }}
        onDragStart={(event) => {
          if ((event.target as Element).closest(".hm-list-rm")) {
            event.preventDefault();
            return;
          }
          event.stopPropagation();
          event.dataTransfer.effectAllowed = "all";
          event.dataTransfer.setData("text/plain", row.code);
          dragRef.current = { kind: "stock", fromThemeId: themeId, code: row.code };
          setDragging(true);
        }}
        onDragEnd={() => {
          setDragging(false);
          onClearMarks();
          dragRef.current = null;
        }}
        onDragOver={(event) => {
          const drag = dragRef.current;
          if (!drag || drag.kind !== "stock") return;
          const sameGroup = drag.fromThemeId === themeId;
          if (sameGroup && (!dndEnabled || drag.code === row.code)) return;
          event.preventDefault();
          event.stopPropagation();
          const copy = !sameGroup && event.shiftKey;
          if (!sameGroup) onStockGroupDrop(copy ? "copy" : "move");
          if (sameGroup || customSort) {
            onRowMark(row.code, lowerHalf(event) ? "after" : "before");
          }
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
            onRowMark(row.code, null);
          }
        }}
        onDrop={(event) => {
          const drag = dragRef.current;
          if (!drag || drag.kind !== "stock") return;
          event.preventDefault();
          event.stopPropagation();
          const after = lowerHalf(event);
          const copy = event.shiftKey;
          onClearMarks();
          dragRef.current = null;
          if (drag.fromThemeId === themeId) {
            if (dndEnabled && drag.code !== row.code) onReorderSymbol(drag.code, row.code, after);
          } else {
            onTransferStock(drag.fromThemeId, drag.code, copy, row.code, after);
          }
        }}
      >
        <span className="hm-list-row-grip" aria-hidden="true">
          <GripIcon size={11} />
        </span>
        <span className="hm-list-name">{row.name}</span>
        <span className="hm-list-price">
          {priceText}
          {expected && <span aria-hidden="true">*</span>}
        </span>
        <span className="hm-list-rate" data-side={side}>
          {rateText}
          {expected && <span aria-hidden="true">*</span>}
        </span>
        <span className="hm-list-traded">{traded}</span>
        <button
          type="button"
          className="hm-list-rm"
          aria-label={`${row.name} 빼기`}
          title="이 테마에서 빼기"
          onClick={(event) => {
            event.stopPropagation();
            onRemove(row.code, row.name);
          }}
        >
          <CloseIcon size={11} />
        </button>
      </div>
    </li>
  );
});

function RenameField({ title, onCommit, onCancel }: { title: string; onCommit(name: string): void; onCancel(): void }) {
  const [text, setText] = useState(title);
  const done = useRef(false);
  const commitNow = () => {
    if (done.current) return;
    done.current = true;
    onCommit(text);
  };
  const cancelNow = () => {
    if (done.current) return;
    done.current = true;
    onCancel();
  };
  return (
    <input
      className="hm-list-rename"
      aria-label={`${title} 새 이름`}
      value={text}
      autoFocus
      onFocus={(event) => event.currentTarget.select()}
      onChange={(event) => setText(event.target.value)}
      onBlur={commitNow}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === "Enter") {
          event.preventDefault();
          commitNow();
        } else if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          cancelNow();
        }
      }}
    />
  );
}

function InlineSymbolAdd({
  themeName,
  symbols,
  onAdd,
  onClose,
}: {
  themeName: string;
  symbols: readonly SymbolCode[];
  onAdd(code: SymbolCode, name: string): void;
  onClose(): void;
}) {
  const [query, setQuery] = useState("");
  const field = useRef<HTMLInputElement>(null);
  const text = query.trim();
  const search = useSymbolSearch(text);
  const rows = (text === "" ? [] : search.data?.rows ?? [])
    .filter((info) => info.kind !== "index" && !isIndexCode(info.code))
    .slice(0, SEARCH_RESULT_LIMIT);
  const full = symbols.length >= MAX_THEME_SYMBOLS;
  const held = (info: SymbolInfo) => symbols.includes(info.code);
  const settled = text !== "" && search.data?.q === text && !search.isFetching;
  const showDrop = text !== "" && (rows.length > 0 || settled);

  useEffect(() => {
    field.current?.focus();
  }, []);

  const pick = (info: SymbolInfo) => {
    onAdd(info.code, info.name);
    field.current?.focus();
  };

  return (
    <div className="hm-list-add">
      <div className="hm-list-add-bar">
        <input
          ref={field}
          type="search"
          className="hm-list-add-input"
          aria-label={`${themeName} 종목 검색`}
          placeholder="종목명 · 코드 입력 후 Enter (Esc 닫기)"
          value={query}
          autoComplete="off"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              onClose();
              return;
            }
            if (event.key === "Enter") {
              event.preventDefault();
              const first = rows.find((info) => !held(info));
              if (first && !full) pick(first);
            }
          }}
        />
        <button type="button" className="hm-list-add-close" aria-label="종목 추가 닫기" onClick={onClose}>
          <CloseIcon size={11} />
        </button>
      </div>
      {showDrop && (
        <div className="hm-list-add-drop">
          {rows.length > 0 ? (
            <ul className="hm-list-add-results" aria-label={`${themeName} 종목 검색 결과`}>
              {rows.map((info) => (
                <li key={info.code}>
                  <button
                    type="button"
                    data-code={info.code}
                    disabled={held(info) || full}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => pick(info)}
                  >
                    <b>{info.name}</b>
                    <small>{info.code}</small>
                    <em>{held(info) ? "이미 있음" : full ? "가득 참" : "넣기"}</em>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="hm-list-add-empty" role="status">찾은 종목이 없습니다</p>
          )}
        </div>
      )}
    </div>
  );
}

interface GroupProps {
  section: HeatmapSection;
  rows: readonly SnapshotRow[];
  names: ReadonlyMap<SymbolCode, string>;
  themes: readonly ThemeChoice[];
  dndEnabled: boolean;
  customSort: boolean;
  collapsed: boolean;
  adding: boolean;
  renaming: boolean;
  deleting: boolean;
  dragRef: RefObject<ListDrag | null>;
  onToggle(key: string): void;
  onToggleAdd(key: string): void;
  onStartRename(key: string): void;
  onCommitRename(key: string, name: string): void;
  onCancelRename(): void;
  onAskDelete(key: string): void;
  onCancelDelete(): void;
  onConfirmDelete(key: string): void;
  edit: InlineEditActions;
}

const ListGroup = memo(function ListGroup({
  section,
  rows,
  names,
  themes,
  dndEnabled,
  customSort,
  collapsed,
  adding,
  renaming,
  deleting,
  dragRef,
  onToggle,
  onToggleAdd,
  onStartRename,
  onCommitRename,
  onCancelRename,
  onAskDelete,
  onCancelDelete,
  onConfirmDelete,
  edit,
}: GroupProps) {
  const send = useSendSymbol();
  const root = useRef<HTMLUListElement>(null);
  const [menu, setMenu] = useState<TileMenuState | null>(null);
  const [draggingGroup, setDraggingGroup] = useState(false);
  const [groupDrop, setGroupDrop] = useState<"before" | "after" | null>(null);
  const [stockDrop, setStockDrop] = useState<"move" | "copy" | null>(null);
  const [rowMark, setRowMark] = useState<{ code: SymbolCode; mark: "before" | "after" } | null>(null);

  const clearMarks = useCallback(() => {
    setGroupDrop(null);
    setStockDrop(null);
    setRowMark(null);
  }, []);

  const handleRowMark = useCallback((code: SymbolCode, mark: "before" | "after" | null) => {
    setRowMark((current) => {
      if (mark === null) return current?.code === code ? null : current;
      if (current?.code === code && current.mark === mark) return current;
      return { code, mark };
    });
  }, []);

  const handleStockGroupDrop = useCallback((mode: "move" | "copy") => {
    setStockDrop((current) => (current === mode ? current : mode));
  }, []);

  const openMenu = useCallback((code: SymbolCode, x: number, y: number) => {
    root.current?.querySelector<HTMLElement>(`.hm-list-row[data-code="${code}"]`)?.focus();
    setMenu({ code, kind: "actions", x, y });
  }, []);

  const sendRow = useCallback((row: SnapshotRow) => send({ code: row.code, name: row.name }), [send]);
  const removeRow = useCallback((code: SymbolCode, name: string) => edit.removeSymbol(section.key, code, name), [edit, section.key]);
  const reorderRow = useCallback((code: SymbolCode, targetCode: SymbolCode, after: boolean) => edit.reorderSymbol(section.key, code, targetCode, after), [edit, section.key]);
  const transferRow = useCallback((fromId: string, code: SymbolCode, copy: boolean, targetCode: SymbolCode, after: boolean) => {
    edit.transferStock(fromId, section.key, code, { copy, targetCode, after });
  }, [edit, section.key]);

  const current = useMemo((): ThemeChoice => ({ id: section.key, name: section.title, symbols: section.symbols }), [section.key, section.title, section.symbols]);
  const weighted = section.theme.summary?.weightedRate ?? null;
  const weightedText = weighted === null ? "–" : formatPercent(weighted);
  const weightedSide = weighted === null ? "none" : rateSide(weighted);
  const intensity = rateIntensityLevel(weighted);

  return (
    <section
      className="hm-list-group"
      aria-label={`${section.title} 목록`}
      data-group={section.key}
      data-collapsed={collapsed ? "" : undefined}
      data-dragging={draggingGroup ? "" : undefined}
      data-drop-group={groupDrop ?? undefined}
      data-drop-stock={stockDrop ?? undefined}
      onDragOver={(event) => {
        const drag = dragRef.current;
        if (!drag) return;
        if (drag.kind === "group") {
          if (!dndEnabled || drag.themeId === section.key) return;
          event.preventDefault();
          const side = rightHalf(event) ? "after" : "before";
          if (groupDrop !== side) setGroupDrop(side);
        } else if (drag.kind === "stock" && drag.fromThemeId !== section.key) {
          event.preventDefault();
          const mode = event.shiftKey ? "copy" : "move";
          if (stockDrop !== mode) setStockDrop(mode);
        }
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) clearMarks();
      }}
      onDrop={(event) => {
        const drag = dragRef.current;
        if (!drag) return;
        event.preventDefault();
        if (drag.kind === "group" && drag.themeId !== section.key && dndEnabled) {
          edit.reorderTheme(drag.themeId, section.key, rightHalf(event));
        } else if (drag.kind === "stock" && drag.fromThemeId !== section.key) {
          edit.transferStock(drag.fromThemeId, section.key, drag.code, { copy: event.shiftKey });
        }
        clearMarks();
        dragRef.current = null;
      }}
    >
      <div
        className="hm-list-head"
        data-side={weightedSide}
        data-level={intensity}
        data-adding={adding ? "" : undefined}
        data-deleting={deleting ? "" : undefined}
        draggable={dndEnabled && !renaming}
        onClick={(event) => {
          if (renaming || (event.target as Element).closest("button, input")) return;
          onToggle(section.key);
        }}
        onDragStart={(event) => {
          if (!dndEnabled || renaming || (event.target as Element).closest("button, input")) {
            event.preventDefault();
            return;
          }
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData("text/plain", section.key);
          dragRef.current = { kind: "group", themeId: section.key };
          setDraggingGroup(true);
        }}
        onDragEnd={() => {
          setDraggingGroup(false);
          clearMarks();
          dragRef.current = null;
        }}
      >
        <span className="hm-list-grip" aria-hidden="true" title={dndEnabled ? "끌어서 테마 순서 변경" : undefined}>
          <GripIcon size={11} />
        </span>
        <button
          type="button"
          className="hm-list-collapse"
          aria-expanded={!collapsed}
          aria-label={collapsed ? `${section.title} 펼치기` : `${section.title} 접기`}
          onClick={(event) => {
            event.stopPropagation();
            onToggle(section.key);
          }}
        >
          <ChevronIcon size={11} />
        </button>

        {renaming ? (
          <RenameField
            title={section.title}
            onCommit={(nextName) => onCommitRename(section.key, nextName)}
            onCancel={onCancelRename}
          />
        ) : (
          <div
            className="hm-list-title"
            title="클릭: 접기/펼치기 · 더블클릭: 이름 수정"
            onDoubleClick={(event) => {
              event.stopPropagation();
              onStartRename(section.key);
            }}
          >
            <h2>{section.title}</h2>
            <span className="hm-list-count" aria-label={`종목 ${rows.length} / ${MAX_THEME_SYMBOLS}`}>
              {rows.length}
            </span>
          </div>
        )}

        {stockDrop && (
          <span className="hm-list-drop-pill" data-mode={stockDrop}>
            {stockDrop === "copy" ? "+ 복제" : "이동"}
          </span>
        )}

        <div className="hm-list-head-actions">
          {deleting ? (
            <span className="hm-list-del-confirm">
              <button type="button" className="hm-list-mini" data-danger="" aria-label={`${section.title} 지우기 확인`} onClick={() => onConfirmDelete(section.key)}>
                지우기
              </button>
              <button type="button" className="hm-list-mini" aria-label={`${section.title} 지우기 취소`} onClick={onCancelDelete}>
                취소
              </button>
            </span>
          ) : (
            <>
              <button
                type="button"
                className="hm-list-head-icon"
                data-active={adding ? "" : undefined}
                aria-label={`${section.title} 종목 추가`}
                title="종목 추가"
                onClick={() => onToggleAdd(section.key)}
              >
                <PlusIcon size={12} />
              </button>
              <button
                type="button"
                className="hm-list-head-icon"
                aria-label={`${section.title} 이름 바꾸기`}
                title="테마 이름 수정"
                onClick={() => onStartRename(section.key)}
              >
                <PenIcon size={11} />
              </button>
              <button
                type="button"
                className="hm-list-head-icon"
                data-danger=""
                aria-label={`${section.title} 지우기`}
                title="테마 지우기"
                onClick={() => {
                  if (section.symbols.length === 0) onConfirmDelete(section.key);
                  else onAskDelete(section.key);
                }}
              >
                <CloseIcon size={11} />
              </button>
            </>
          )}
        </div>

        <span className="hm-list-avg" data-side={weightedSide} aria-label={`거래대금 가중 평균 ${weightedText}`}>
          {weightedText}
        </span>
      </div>

      {!collapsed && (
        <>
          {rows.length === 0 ? (
            <div className="hm-list-empty">
              <span>종목을 끌어 놓거나</span>
              <button type="button" onClick={() => onToggleAdd(section.key)}>+ 종목 추가</button>
            </div>
          ) : (
            <ul ref={root} className="hm-list-rows" aria-label={`${section.title} 담은 종목`}>
              {rows.map((row) => (
                <ListRow
                  key={row.code}
                  themeId={section.key}
                  row={row}
                  dndEnabled={dndEnabled}
                  customSort={customSort}
                  dragRef={dragRef}
                  dropMark={rowMark?.code === row.code ? rowMark.mark : undefined}
                  onRowMark={handleRowMark}
                  onStockGroupDrop={handleStockGroupDrop}
                  onClearMarks={clearMarks}
                  onSend={sendRow}
                  onMenu={openMenu}
                  onRemove={removeRow}
                  onReorderSymbol={reorderRow}
                  onTransferStock={transferRow}
                />
              ))}
            </ul>
          )}
          {adding && (
            <InlineSymbolAdd
              themeName={section.title}
              symbols={section.symbols}
              onAdd={(code, name) => edit.addSymbol(section.key, code, name)}
              onClose={() => onToggleAdd(section.key)}
            />
          )}
        </>
      )}

      {menu && (
        <TileMenu
          name={names.get(menu.code) ?? menu.code}
          code={menu.code}
          current={current}
          themes={themes}
          menu={menu}
          root={root}
          onSend={() => send({ code: menu.code, name: names.get(menu.code) ?? menu.code })}
          onAddToWatchlist={() => addToActiveWatchlist(menu.code, names.get(menu.code) ?? menu.code)}
          onShowThemes={() => setMenu({ ...menu, kind: "themes" })}
          onBack={() => setMenu({ ...menu, kind: "actions" })}
          onAdd={(target) => edit.addSymbol(target.id, menu.code, names.get(menu.code) ?? menu.code)}
          onRemove={() => edit.removeSymbol(section.key, menu.code, names.get(menu.code) ?? menu.code)}
          onClose={() => setMenu((open) => (open === menu ? null : open))}
        />
      )}
    </section>
  );
});

export function HeatmapList({ sections, settings, names, themes, query, edit }: ListProps) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [addingId, setAddingId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const dragRef = useRef<ListDrag | null>(null);

  useEffect(() => {
    if (edit.justCreatedId === null) return;
    setAddingId(edit.justCreatedId);
    setCollapsed((current) => {
      if (!current.has(edit.justCreatedId!)) return current;
      const next = new Set(current);
      next.delete(edit.justCreatedId!);
      return next;
    });
    edit.clearJustCreated();
  }, [edit]);

  const toggle = useCallback((key: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  }, []);

  const toggleAdd = useCallback((key: string) => {
    setAddingId((current) => (current === key ? null : key));
    setCollapsed((current) => {
      if (!current.has(key)) return current;
      const next = new Set(current);
      next.delete(key);
      return next;
    });
  }, []);

  const startRename = useCallback((key: string) => {
    setRenamingId(key);
    setDeletingId(null);
  }, []);

  const commitRename = useCallback((key: string, name: string) => {
    setRenamingId(null);
    edit.rename(key, name);
  }, [edit]);

  const cancelRename = useCallback(() => setRenamingId(null), []);
  const askDelete = useCallback((key: string) => {
    setDeletingId(key);
    setRenamingId(null);
  }, []);
  const cancelDelete = useCallback(() => setDeletingId(null), []);
  const confirmDelete = useCallback((key: string) => {
    setDeletingId(null);
    setAddingId((current) => (current === key ? null : current));
    edit.removeTheme(key);
  }, [edit]);

  const needle = query.trim().toLowerCase();
  const visible = useMemo(() => sections.flatMap((section) => {
    const all = sortRows(boardRows(section.theme, names), settings.sort);
    if (!needle) return [{ section, rows: all }];
    if (section.title.toLowerCase().includes(needle)) return [{ section, rows: all }];
    const matched = all.filter((row) => row.name.toLowerCase().includes(needle) || row.code.toLowerCase().includes(needle));
    return matched.length > 0 ? [{ section, rows: matched }] : [];
  }), [sections, names, settings.sort, needle]);

  if (needle && visible.length === 0) {
    return <EmptyState title="조건에 맞는 종목이 없습니다" />;
  }

  return (
    <div className="hm-list-groups">
      {visible.map(({ section, rows }) => (
        <ListGroup
          key={section.key}
          section={section}
          rows={rows}
          names={names}
          themes={themes}
          dndEnabled={!needle}
          customSort={settings.sort === "custom"}
          collapsed={collapsed.has(section.key)}
          adding={addingId === section.key}
          renaming={renamingId === section.key}
          deleting={deletingId === section.key}
          dragRef={dragRef}
          onToggle={toggle}
          onToggleAdd={toggleAdd}
          onStartRename={startRename}
          onCommitRename={commitRename}
          onCancelRename={cancelRename}
          onAskDelete={askDelete}
          onCancelDelete={cancelDelete}
          onConfirmDelete={confirmDelete}
          edit={edit}
        />
      ))}
    </div>
  );
}
