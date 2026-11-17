import { type RefObject, useCallback, useRef, useState } from "react";
import type { WatchGroup } from "../../api/generated/WatchGroup";
import type { Watchlist } from "../../api/generated/Watchlist";
import { groupNameProblem, MAX_WATCH_GROUPS } from "../../lib/watchlist";
import { useSelectionStore } from "../../stores/selection";
import { useWatchlistStore } from "../../stores/watchlist";
import { ChevronIcon, PlusIcon } from "../icons";
import { Menu, type MenuItem } from "../menu/Menu";

const NO_GROUP = "그룹 없음";

export function PutTargetPill({ list, group, pillRef, onType, onBack }: { list: Watchlist; group: WatchGroup | null; pillRef: RefObject<HTMLButtonElement | null>; onType(char: string): void; onBack(): void }) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const close = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    setTyped("");
    if (restoreFocus) pillRef.current?.focus();
  }, [pillRef]);
  const choose = (groupId: string | null) => useSelectionStore.getState().setPutTarget({ listId: list.id, groupId });
  const name = typed.trim();
  const needle = name.toLocaleLowerCase();
  const shown = (label: string) => label.toLocaleLowerCase().includes(needle);
  const problem = list.groups.length >= MAX_WATCH_GROUPS ? `그룹은 ${MAX_WATCH_GROUPS}개까지입니다` : groupNameProblem(list, name, null);
  const offersNewGroup = name !== "" && !list.groups.some((g) => g.name === name);
  const items: MenuItem[] = [
    ...(shown(NO_GROUP) ? [{ kind: "radio", label: NO_GROUP, value: "", checked: group === null, onSelect: () => choose(null) } satisfies MenuItem] : []),
    ...list.groups.filter((g) => shown(g.name)).map((g): MenuItem => ({ kind: "radio", label: g.name, value: g.id, hint: `${g.symbols.length}`, checked: g.id === group?.id, onSelect: () => choose(g.id) })),
    ...(offersNewGroup ? [
      { kind: "separator" } satisfies MenuItem,
      { kind: "action", icon: <PlusIcon />, label: `'${name}' 새 그룹 만들고 넣을 곳으로`, disabled: problem !== null, hint: problem ?? undefined, onSelect: () => {
        const id = crypto.randomUUID();
        useWatchlistStore.getState().createGroup(list.id, id, name);
        choose(id);
      } } satisfies MenuItem,
    ] : []),
  ];
  const shownName = group?.name ?? NO_GROUP;
  return <div ref={root} className="min-w-0 flex-none">
    <button ref={pillRef} type="button" aria-label={`넣을 곳: ${shownName}`} aria-haspopup="menu" aria-expanded={open} title="넣을 곳 바꾸기 (Tab)"
      onClick={() => setOpen((o) => !o)}
      onKeyDown={(e) => {
        if (e.nativeEvent.isComposing) return;
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setOpen(true);
        } else if (e.key === "Tab" && e.shiftKey) {
          e.preventDefault();
          e.stopPropagation();
          onBack();
        } else if (e.key.length === 1 && e.key !== " " && !e.ctrlKey && !e.metaKey && !e.altKey) {
          e.preventDefault();
          onType(e.key);
        }
      }}
      className="inline-flex h-7 max-w-full items-center gap-1.5 rounded-full border border-[var(--line-strong)] pl-2.5 pr-2 text-xs hover:bg-[var(--hover)] max-md:h-9">
      <span className="flex-none text-text-3">넣을 곳</span>
      <span aria-hidden="true" className={`h-3.5 w-[3px] flex-none rounded-s ${group ? "bg-accent" : "bg-text-3"}`} />
      <span className="min-w-0 max-w-[9rem] truncate font-semibold text-text">{shownName}</span>
      <span aria-hidden="true" className="flex-none text-text-3"><ChevronIcon size={12} /></span>
    </button>
    {open && <Menu label="넣을 곳" items={items} onClose={close} root={root} placement="top" style={{ minWidth: 260 }}
      filter={{ label: "넣을 곳 찾기", placeholder: "그룹 찾기 또는 새 이름", value: typed, onChange: setTyped }}
      className="fixed max-h-[min(60dvh,420px)] max-w-[calc(100vw-16px)] overflow-auto" />}
  </div>;
}
