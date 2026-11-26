import { type DragEvent, type RefObject, useRef, useState } from "react";
import type { HeatmapTheme } from "../../api/generated/HeatmapTheme";
import type { SymbolCode } from "../../api/generated/SymbolCode";
import type { SymbolInfo } from "../../api/generated/SymbolInfo";
import { useSymbolSearch } from "../../api/queries";
import { formatPercent } from "../../lib/format";
import { rateSide } from "../../lib/heat/colors";
import { MAX_THEME_SYMBOLS } from "../../lib/heatmapThemes";
import { isIndexCode } from "../../lib/symbol";
import { CloseIcon, GripIcon } from "../icons";

const SEARCH_RESULT_LIMIT = 8;

export type BoardDrag =
  | { kind: "theme"; themeId: string }
  | { kind: "symbol"; themeId: string; code: SymbolCode };

interface ColumnProps {
  theme: HeatmapTheme;
  index: number;
  renaming: boolean;
  deleting: boolean;
  names: ReadonlyMap<SymbolCode, string>;
  rates: ReadonlyMap<SymbolCode, number | null>;
  dragRef: RefObject<BoardDrag | null>;
  onStartRename(): void;
  onCommitRename(name: string): void;
  onAskDelete(): void;
  onCancelDelete(): void;
  onDelete(): void;
  onAddSymbol(code: SymbolCode, name: string): void;
  onRemoveSymbol(code: SymbolCode): void;
  onMoveTheme(fromId: string, toIndex: number): void;
  onMoveSymbol(fromIndex: number, toIndex: number): void;
  onTransferSymbol(fromId: string, code: SymbolCode, copy: boolean, toIndex?: number): void;
}

function RenameField({ theme, onCommit }: { theme: HeatmapTheme; onCommit(name: string): void }) {
  const [text, setText] = useState(theme.name);
  const done = useRef(false);
  const finish = () => {
    if (done.current) return;
    done.current = true;
    onCommit(text.trim());
  };
  return (
    <input
      className="ui-field hm-edit-rename"
      aria-label={`${theme.name} 새 이름`}
      value={text}
      autoFocus
      onFocus={(event) => event.currentTarget.select()}
      onChange={(event) => setText(event.target.value)}
      onBlur={finish}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === "Enter") {
          event.preventDefault();
          finish();
        }
      }}
    />
  );
}

function InlineSymbolAdd({ theme, onAdd }: { theme: HeatmapTheme; onAdd(code: SymbolCode, name: string): void }) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const text = query.trim();
  const search = useSymbolSearch(text);
  const rows = (text === "" ? [] : search.data?.rows ?? [])
    .filter((info) => info.kind !== "index" && !isIndexCode(info.code))
    .slice(0, SEARCH_RESULT_LIMIT);
  const full = theme.symbols.length >= MAX_THEME_SYMBOLS;
  const held = (info: SymbolInfo) => theme.symbols.includes(info.code);
  const settled = text !== "" && search.data?.q === text && !search.isFetching;
  const pick = (info: SymbolInfo) => {
    onAdd(info.code, info.name);
    field.current?.focus();
  };
  const showDrop = open && text !== "" && (rows.length > 0 || settled);
  return (
    <div
      ref={wrap}
      className="hm-edit-col-add"
      data-search-open={showDrop || query !== "" ? "" : undefined}
      onBlur={(event) => {
        if (!wrap.current?.contains(event.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      <input
        ref={field}
        type="search"
        className="hm-edit-add-input"
        aria-label={`${theme.name} 종목 검색`}
        placeholder="+ 종목 추가..."
        value={query}
        autoComplete="off"
        onFocus={() => setOpen(true)}
        onChange={(event) => {
          setQuery(event.target.value);
          setOpen(true);
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "Escape" && (open || query !== "")) {
            event.preventDefault();
            event.stopPropagation();
            setOpen(false);
            setQuery("");
            return;
          }
          if (event.key === "Enter") {
            event.preventDefault();
            const first = rows.find((info) => !held(info));
            if (first && !full) pick(first);
          }
        }}
      />
      {showDrop && (
        <div className="hm-edit-drop">
          {rows.length > 0 ? (
            <ul className="hm-edit-results" aria-label={`${theme.name} 종목 검색 결과`}>
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
            <p className="hm-edit-drop-empty" role="status">찾은 종목이 없습니다</p>
          )}
        </div>
      )}
    </div>
  );
}

const lowerHalf = (event: DragEvent<HTMLElement>) => {
  const box = event.currentTarget.getBoundingClientRect();
  return event.clientY > box.top + box.height / 2;
};

const rightHalf = (event: DragEvent<HTMLElement>) => {
  const box = event.currentTarget.getBoundingClientRect();
  return event.clientX > box.left + box.width / 2;
};

export function ThemeColumn({
  theme,
  index,
  renaming,
  deleting,
  names,
  rates,
  dragRef,
  onStartRename,
  onCommitRename,
  onAskDelete,
  onCancelDelete,
  onDelete,
  onAddSymbol,
  onRemoveSymbol,
  onMoveTheme,
  onMoveSymbol,
  onTransferSymbol,
}: ColumnProps) {
  const [colDrop, setColDrop] = useState<"before" | "after" | null>(null);
  const [stockDrop, setStockDrop] = useState(false);
  const [rowMark, setRowMark] = useState<{ index: number; after: boolean } | null>(null);

  const clearMarks = () => {
    setColDrop(null);
    setStockDrop(false);
    setRowMark(null);
  };

  const nameOf = (code: SymbolCode) => names.get(code) ?? code;

  return (
    <section
      className="hm-edit-col"
      aria-label={`${theme.name} 테마`}
      data-theme-id={theme.id}
      data-drop-col={colDrop ?? undefined}
      data-drop-stock={stockDrop ? "" : undefined}
      onDragOver={(event) => {
        const drag = dragRef.current;
        if (!drag) return;
        if (drag.kind === "theme" && drag.themeId !== theme.id) {
          event.preventDefault();
          const side = rightHalf(event) ? "after" : "before";
          if (colDrop !== side) setColDrop(side);
        } else if (drag.kind === "symbol" && drag.themeId !== theme.id) {
          event.preventDefault();
          if (!stockDrop) setStockDrop(true);
        }
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) clearMarks();
      }}
      onDrop={(event) => {
        const drag = dragRef.current;
        if (!drag) return;
        event.preventDefault();
        if (drag.kind === "theme" && drag.themeId !== theme.id) {
          const target = index + (rightHalf(event) ? 1 : 0);
          onMoveTheme(drag.themeId, target);
        } else if (drag.kind === "symbol" && drag.themeId !== theme.id) {
          onTransferSymbol(drag.themeId, drag.code, event.shiftKey);
        }
        clearMarks();
        dragRef.current = null;
      }}
    >
      <div
        className="hm-edit-col-head"
        draggable={!renaming}
        onDragStart={(event) => {
          if (renaming) return;
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData("text/plain", theme.id);
          dragRef.current = { kind: "theme", themeId: theme.id };
        }}
        onDragEnd={() => {
          clearMarks();
          dragRef.current = null;
        }}
      >
        <span className="hm-edit-grip" aria-hidden="true" title="끌어서 테마 순서 바꾸기">
          <GripIcon size={12} />
        </span>
        {renaming ? (
          <RenameField theme={theme} onCommit={onCommitRename} />
        ) : (
          <button
            type="button"
            className="hm-edit-col-title"
            aria-label={`${theme.name} 이름 바꾸기`}
            title="눌러서 이름 바꾸기"
            onClick={onStartRename}
          >
            {theme.name}
          </button>
        )}
        <span className="hm-edit-col-count" aria-label={`종목 ${theme.symbols.length} / ${MAX_THEME_SYMBOLS}`}>
          {theme.symbols.length}/{MAX_THEME_SYMBOLS}
        </span>
        {deleting ? (
          <span className="hm-edit-del-confirm">
            <button type="button" className="hm-edit-small" data-danger="" aria-label={`${theme.name} 지우기 확인`} onClick={onDelete}>
              지우기
            </button>
            <button type="button" className="hm-edit-small" aria-label={`${theme.name} 지우기 취소`} onClick={onCancelDelete}>
              취소
            </button>
          </span>
        ) : (
          <button type="button" className="hm-edit-col-del" aria-label={`${theme.name} 지우기`} title="테마 지우기" onClick={onAskDelete}>
            <CloseIcon size={12} />
          </button>
        )}
      </div>

      <ul className="hm-edit-rows" aria-label={`${theme.name} 담은 종목`}>
        {theme.symbols.length === 0 ? (
          <li className="hm-edit-col-empty">종목을 끌어 놓거나 아래에서 추가</li>
        ) : (
          theme.symbols.map((code, symIndex) => {
            const rate = rates.get(code) ?? null;
            const side = rate === null ? "none" : rateSide(rate);
            const mark = rowMark?.index === symIndex ? (rowMark.after ? "after" : "before") : undefined;
            return (
              <li
                key={code}
                className="hm-edit-sym"
                data-code={code}
                data-drop={mark}
                draggable
                onDragStart={(event) => {
                  event.stopPropagation();
                  event.dataTransfer.effectAllowed = "all";
                  event.dataTransfer.setData("text/plain", code);
                  dragRef.current = { kind: "symbol", themeId: theme.id, code };
                }}
                onDragOver={(event) => {
                  const drag = dragRef.current;
                  if (!drag || drag.kind !== "symbol") return;
                  event.preventDefault();
                  event.stopPropagation();
                  const after = lowerHalf(event);
                  if (rowMark?.index !== symIndex || rowMark.after !== after) setRowMark({ index: symIndex, after });
                  if (drag.themeId !== theme.id && !stockDrop) setStockDrop(true);
                }}
                onDrop={(event) => {
                  const drag = dragRef.current;
                  if (!drag || drag.kind !== "symbol") return;
                  event.preventDefault();
                  event.stopPropagation();
                  const after = lowerHalf(event);
                  if (drag.themeId === theme.id) {
                    const from = theme.symbols.indexOf(drag.code);
                    if (from >= 0) {
                      const slot = symIndex + (after ? 1 : 0);
                      onMoveSymbol(from, slot > from ? slot - 1 : slot);
                    }
                  } else {
                    const insertIndex = symIndex + (after ? 1 : 0);
                    onTransferSymbol(drag.themeId, drag.code, event.shiftKey, insertIndex);
                  }
                  clearMarks();
                  dragRef.current = null;
                }}
                onDragEnd={() => {
                  clearMarks();
                  dragRef.current = null;
                }}
              >
                <span className="hm-edit-grip" aria-hidden="true" title="끌어서 순서 바꾸기 또는 다른 테마로 이동">
                  <GripIcon size={11} />
                </span>
                <span className="hm-edit-sym-name">{nameOf(code)}</span>
                {rate !== null ? (
                  <span className="hm-edit-sym-rate" data-side={side}>{formatPercent(rate)}</span>
                ) : (
                  <span className="hm-edit-sym-code">{code}</span>
                )}
                <button
                  type="button"
                  className="hm-edit-sym-rm"
                  aria-label={`${nameOf(code)} 빼기`}
                  title="빼기"
                  onClick={() => onRemoveSymbol(code)}
                >
                  <CloseIcon size={11} />
                </button>
              </li>
            );
          })
        )}
      </ul>

      <InlineSymbolAdd theme={theme} onAdd={onAddSymbol} />
    </section>
  );
}
