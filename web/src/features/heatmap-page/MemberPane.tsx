import { useRef, useState } from "react";
import type { HeatmapTheme } from "../../api/generated/HeatmapTheme";
import type { SymbolCode } from "../../api/generated/SymbolCode";
import type { SymbolInfo } from "../../api/generated/SymbolInfo";
import { useSymbolInfos, useSymbolSearch } from "../../api/queries";
import { MAX_THEME_SYMBOLS } from "../../lib/heatmapThemes";
import { isIndexCode } from "../../lib/symbol";
import { ArrowIcon, CloseIcon, GripIcon } from "../icons";
import { useReorder } from "./useReorder";

const SEARCH_RESULT_LIMIT = 8;

interface Props {
  theme: HeatmapTheme | null;
  searchedNames: ReadonlyMap<SymbolCode, string>;
  onAdd(code: SymbolCode, name: string): void;
  onRemove(code: SymbolCode): void;
  onMove(from: number, to: number): void;
}

function SymbolSearch({ theme, onAdd }: { theme: HeatmapTheme; onAdd(code: SymbolCode, name: string): void }) {
  const [query, setQuery] = useState("");
  const field = useRef<HTMLInputElement>(null);
  const text = query.trim();
  const search = useSymbolSearch(text);
  const rows = (text === "" ? [] : search.data?.rows ?? []).filter((info) => info.kind !== "index" && !isIndexCode(info.code)).slice(0, SEARCH_RESULT_LIMIT);
  const full = theme.symbols.length >= MAX_THEME_SYMBOLS;
  const held = (info: SymbolInfo) => theme.symbols.includes(info.code);
  const settled = text !== "" && search.data?.q === text && !search.isFetching;
  const add = (info: SymbolInfo) => {
    onAdd(info.code, info.name);
    field.current?.focus();
  };
  return (
    <>
      <input
        ref={field}
        type="search"
        className="ui-field hm-edit-field"
        aria-label="종목 검색"
        placeholder="종목 이름이나 코드로 찾아 넣기"
        value={query}
        autoComplete="off"
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
          event.preventDefault();
          const first = rows.find((info) => !held(info));
          if (first && !full) add(first);
        }}
      />
      {rows.length > 0 && (
        <ul className="hm-edit-results" aria-label="종목 검색 결과">
          {rows.map((info) => (
            <li key={info.code}>
              <button type="button" data-code={info.code} disabled={held(info) || full} onClick={() => add(info)}>
                <b>{info.name}</b>
                <small>{info.code}</small>
                <em>{held(info) ? "이미 있음" : full ? "가득 참" : "넣기"}</em>
              </button>
            </li>
          ))}
        </ul>
      )}
      {settled && rows.length === 0 && <p className="hm-edit-note" role="status">찾은 종목이 없습니다</p>}
    </>
  );
}

export function MemberPane({ theme, searchedNames, onAdd, onRemove, onMove }: Props) {
  const infos = useSymbolInfos(theme?.symbols ?? []);
  const reorder = useReorder(onMove);
  if (theme === null) {
    return (
      <section className="hm-edit-pane" aria-label="테마 종목">
        <p className="hm-edit-note">왼쪽에서 테마를 고르면 종목을 넣고 뺄 수 있습니다.</p>
      </section>
    );
  }
  const names = new Map(infos.map((info) => [info.code, info.name] as const));
  const nameOf = (code: SymbolCode) => names.get(code) ?? searchedNames.get(code) ?? code;
  return (
    <section className="hm-edit-pane" aria-label={`${theme.name} 종목`}>
      <div className="hm-edit-title">
        <b>{theme.name}</b>
        <span>종목 {theme.symbols.length} / {MAX_THEME_SYMBOLS}</span>
      </div>
      <SymbolSearch key={theme.id} theme={theme} onAdd={onAdd} />
      {theme.symbols.length === 0 ? (
        <p className="hm-edit-note">종목이 없습니다. 위 검색 칸에서 찾아 넣으세요.</p>
      ) : (
        <ul className="hm-edit-rows" aria-label="담은 종목">
          {theme.symbols.map((code, index) => (
            <li key={code} className="hm-edit-row" data-code={code} {...reorder(index)}>
              <span className="hm-edit-grip" aria-hidden="true" title="끌어서 순서 바꾸기"><GripIcon /></span>
              <span className="hm-edit-main">
                <b>{nameOf(code)}</b>
                <small>{code}</small>
              </span>
              <button type="button" className="icon-btn" aria-label={`${nameOf(code)} 위로`} disabled={index === 0} onClick={() => onMove(index, index - 1)}><ArrowIcon dir="up" /></button>
              <button type="button" className="icon-btn" aria-label={`${nameOf(code)} 아래로`} disabled={index === theme.symbols.length - 1} onClick={() => onMove(index, index + 1)}><ArrowIcon dir="down" /></button>
              <button type="button" className="icon-btn" aria-label={`${nameOf(code)} 빼기`} title="빼기" onClick={() => onRemove(code)}><CloseIcon /></button>
            </li>
          ))}
        </ul>
      )}
      <p className="hm-edit-note">한 종목을 여러 테마에 넣을 수 있습니다. 보드에서 칸 자리는 거래대금과 칸 정렬 설정이 정하고, 여기 순서는 저장 순서입니다.</p>
    </section>
  );
}
