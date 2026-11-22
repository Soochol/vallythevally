import { type MutableRefObject, useEffect, useRef, useState } from "react";
import type { HeatmapTheme } from "../../api/generated/HeatmapTheme";
import type { Watchlist } from "../../api/generated/Watchlist";
import { MAX_THEME_NAME_CHARS, MAX_THEMES } from "../../lib/heatmapThemes";
import { ArrowIcon, CloseIcon, GripIcon, PenIcon } from "../icons";
import { useReorder } from "./useReorder";

interface Props {
  themes: readonly HeatmapTheme[];
  selectedId: string | null;
  renamingId: string | null;
  deletingId: string | null;
  importing: boolean;
  focusNewName: boolean;
  lists: readonly Watchlist[];
  notices: readonly string[];
  dismissRename: MutableRefObject<() => boolean>;
  onSelect(id: string): void;
  onCreate(name: string): boolean;
  onStartRename(id: string): void;
  onCommitRename(id: string, name: string): void;
  onCancelRename(): void;
  onAskDelete(id: string): void;
  onCancelDelete(): void;
  onDelete(id: string): void;
  onMove(from: number, to: number): void;
  onToggleImport(): void;
  onImport(listId: string): void;
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
      className="ui-field hm-edit-field"
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

function ThemeRow({ theme, index, last, props, row }: {
  theme: HeatmapTheme;
  index: number;
  last: boolean;
  props: Props;
  row: ReturnType<ReturnType<typeof useReorder>>;
}) {
  const renaming = props.renamingId === theme.id;
  const deleting = props.deletingId === theme.id;
  const selected = props.selectedId === theme.id;
  return (
    <li className="hm-edit-row" aria-current={selected ? "true" : undefined} {...row} draggable={row.draggable && !renaming}>
      <span className="hm-edit-grip" aria-hidden="true" title="끌어서 순서 바꾸기"><GripIcon /></span>
      {renaming ? (
        <RenameField theme={theme} onCommit={(name) => props.onCommitRename(theme.id, name)} />
      ) : (
        <button type="button" className="hm-edit-main" aria-label={`${theme.name} 테마 고르기`} aria-pressed={selected} onClick={() => props.onSelect(theme.id)}>
          <b>{theme.name}</b>
          <small>{theme.symbols.length}</small>
        </button>
      )}
      {deleting ? (
        <>
          <button type="button" className="hm-edit-small" data-danger="" aria-label={`${theme.name} 지우기 확인`} onClick={() => props.onDelete(theme.id)}>지우기</button>
          <button type="button" className="hm-edit-small" aria-label={`${theme.name} 지우기 취소`} onClick={props.onCancelDelete}>취소</button>
        </>
      ) : (
        <>
          <button type="button" className="icon-btn" aria-label={`${theme.name} 위로`} disabled={index === 0} onClick={() => props.onMove(index, index - 1)}><ArrowIcon dir="up" /></button>
          <button type="button" className="icon-btn" aria-label={`${theme.name} 아래로`} disabled={last} onClick={() => props.onMove(index, index + 1)}><ArrowIcon dir="down" /></button>
          <button type="button" className="icon-btn" aria-label={`${theme.name} 이름 바꾸기`} title="이름 바꾸기" onClick={() => props.onStartRename(theme.id)}><PenIcon /></button>
          <button type="button" className="icon-btn" aria-label={`${theme.name} 지우기`} title="지우기" onClick={() => props.onAskDelete(theme.id)}><CloseIcon /></button>
        </>
      )}
    </li>
  );
}

export function ThemeListPane(outer: Props) {
  const cancelledRename = useRef(false);
  const props: Props = {
    ...outer,
    onStartRename: (id) => {
      cancelledRename.current = false;
      outer.onStartRename(id);
    },
    onCommitRename: (id, name) => {
      if (cancelledRename.current) {
        cancelledRename.current = false;
        return;
      }
      outer.onCommitRename(id, name);
    },
  };
  const { themes, importing, lists, notices } = props;
  const reorder = useReorder(props.onMove);
  const [name, setName] = useState("");
  const newName = useRef<HTMLInputElement>(null);
  props.dismissRename.current = () => {
    if (props.renamingId === null) return false;
    cancelledRename.current = true;
    props.onCancelRename();
    return true;
  };
  useEffect(() => {
    if (props.focusNewName) newName.current?.focus();
  }, [props.focusNewName]);
  return (
    <section className="hm-edit-pane" aria-label="테마 목록">
      <div className="hm-edit-title">
        <b>테마</b>
        <span>{themes.length} / {MAX_THEMES}</span>
      </div>
      {themes.length === 0 ? (
        <p className="hm-edit-note">아직 테마가 없습니다. 아래에서 만들거나 관심종목 그룹에서 가져오세요.</p>
      ) : (
        <ul className="hm-edit-rows" aria-label="테마">
          {themes.map((theme, index) => (
            <ThemeRow key={theme.id} theme={theme} index={index} last={index === themes.length - 1} props={props} row={reorder(index)} />
          ))}
        </ul>
      )}
      <form
        className="hm-edit-inline"
        onSubmit={(event) => {
          event.preventDefault();
          if (props.onCreate(name.trim())) setName("");
        }}
      >
        <input ref={newName} className="ui-field hm-edit-field" aria-label="새 테마 이름" placeholder={`새 테마 이름 (${MAX_THEME_NAME_CHARS}자까지)`} value={name} autoComplete="off" onChange={(event) => setName(event.target.value)} />
        <button type="submit" className="tb-btn hm-edit-add">테마 추가</button>
      </form>
      {importing ? (
        <div className="hm-edit-box" role="group" aria-label="관심종목 그룹에서 가져오기">
          <b>관심종목 그룹에서 가져오기</b>
          <p>목록 하나를 고르면 그 목록의 그룹이 같은 이름·순서의 테마로 추가됩니다. 관심종목은 바뀌지 않습니다.</p>
          {lists.map((list) => (
            <button key={list.id} type="button" className="tb-btn hm-edit-list" onClick={() => props.onImport(list.id)}>
              {list.name} · 그룹 {list.groups.length}개
            </button>
          ))}
          <button type="button" className="hm-edit-small" onClick={props.onToggleImport}>닫기</button>
        </div>
      ) : (
        <button type="button" className="tb-btn hm-edit-import" onClick={props.onToggleImport}>관심종목 그룹에서 가져오기</button>
      )}
      {notices.length > 0 && (
        <ul className="hm-edit-notices" role="status" aria-label="가져오기 결과">
          {notices.map((notice) => <li key={notice}>{notice}</li>)}
        </ul>
      )}
    </section>
  );
}
