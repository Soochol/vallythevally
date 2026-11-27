import { type KeyboardEvent, type ReactNode, useId, useRef, useState } from "react";
import { collectorAllowed, useCollectorAccess } from "../api/collector";
import { DESKTOP_QUERY, useMediaQuery } from "../lib/media";
import { DialogFrame } from "../features/dialog/DialogParts";
import { CollectorBoard } from "../features/collector-board/CollectorBoard";
import { ChartIcon, ChevronIcon, CloseIcon, KeyboardIcon, UserIcon } from "../features/icons";
import { HotkeysMenuContent } from "../features/system-settings/HotkeysMenuContent";
import { cancelHotkeyRecording } from "../features/system-settings/hotkeyRecording";
import type { SystemMenuId } from "../features/system-settings/menus";
import { useSelectionStore } from "../stores/selection";
import { PublicAccountMenu } from "./PublicAccountMenu";
import "../features/system-settings/system-settings.css";

type PublicMenuId = Extract<SystemMenuId, "hotkeys" | "collector" | "account">;

const MENUS: readonly { id: PublicMenuId; label: string; icon: ReactNode }[] = [
  { id: "hotkeys", label: "단축키", icon: <KeyboardIcon /> },
  { id: "collector", label: "수집 현황판", icon: <ChartIcon size={16} /> },
  { id: "account", label: "계정", icon: <UserIcon /> },
];

export function PublicSystemSettings({ menu }: { menu: SystemMenuId | null }) {
  const close = useSelectionStore((s) => s.closeDialog);
  const desktop = useMediaQuery(DESKTOP_QUERY);
  const ids = useId();
  const collector = collectorAllowed(useCollectorAccess());
  const menus = MENUS.filter((m) => m.id !== "collector" || collector);
  const [selected, setSelected] = useState<PublicMenuId>(() => MENUS.find((m) => m.id === menu)?.id ?? "hotkeys");
  const [view, setView] = useState<"list" | "content">(() => (menu !== null ? "content" : "list"));
  const title = useRef<HTMLHeadingElement>(null);
  const current = menus.find((m) => m.id === selected) ?? menus[0]!;
  const tabId = (id: PublicMenuId) => `${ids}-tab-${id}`;
  const showList = desktop || view === "list";
  const showContent = desktop || view === "content";

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const idx = menus.findIndex((m) => m.id === current.id);
    let nextIdx = -1;
    if (e.key === "ArrowDown") nextIdx = (idx + 1) % menus.length;
    else if (e.key === "ArrowUp") nextIdx = (idx - 1 + menus.length) % menus.length;
    else if (e.key === "Home") nextIdx = 0;
    else if (e.key === "End") nextIdx = menus.length - 1;
    if (nextIdx < 0) return;
    e.preventDefault();
    const next = menus[nextIdx]!.id;
    setSelected(next);
    document.getElementById(tabId(next))?.focus();
  };

  return (
    <DialogFrame solid labelledBy={`${ids}-title`} width="h-[min(680px,calc(100dvh-48px))] w-[min(940px,calc(100vw-48px))] max-md:h-[85dvh]" onClose={(reason) => { if (reason !== "outside" && cancelHotkeyRecording()) return; close(); }}>
      <div className="sys-dialog flex min-h-0 flex-1 max-md:flex-col">
        <h2 id={`${ids}-title`} className="sr-only">시스템 설정</h2>
        {showList && (
          <nav aria-label="시스템 설정 메뉴" className="flex w-[208px] flex-none flex-col gap-1 overflow-y-auto border-r border-line p-3 max-md:w-full max-md:flex-1 max-md:border-r-0 max-md:p-0">
            <div className="flex items-center justify-between px-2 pb-2 pt-1 max-md:h-12 max-md:px-4 max-md:pb-0">
              <span aria-hidden="true" className="text-m font-semibold">시스템 설정</span>
              <button type="button" className="icon-btn hidden max-md:grid" aria-label="닫기" onClick={close}><CloseIcon /></button>
            </div>
            <div role="tablist" aria-orientation="vertical" aria-label="시스템 설정 메뉴" onKeyDown={onKeyDown} className="flex flex-col gap-0.5 max-md:gap-0">
              {menus.map((m) => (
                <button
                  key={m.id}
                  id={tabId(m.id)}
                  type="button"
                  role="tab"
                  aria-selected={m.id === current.id}
                  aria-controls={showContent ? `${ids}-panel` : undefined}
                  tabIndex={m.id === current.id ? 0 : -1}
                  onClick={() => { setSelected(m.id); setView("content"); }}
                  className="flex h-9 items-center gap-2 rounded-s px-2 text-left text-text-2 hover:bg-hover hover:text-text aria-selected:bg-hover aria-selected:font-semibold aria-selected:text-text aria-selected:shadow-[inset_2px_0_0_var(--accent)] max-md:h-12 max-md:rounded-none max-md:border-t max-md:border-line max-md:px-4 max-md:aria-selected:bg-transparent max-md:aria-selected:text-text max-md:aria-selected:shadow-none"
                >
                  <span aria-hidden="true" className="flex-none">{m.icon}</span>
                  <span className="min-w-0 flex-1 truncate">{m.label}</span>
                </button>
              ))}
            </div>
          </nav>
        )}
        {showContent && (
          <section role="tabpanel" id={`${ids}-panel`} aria-labelledby={showList ? tabId(current.id) : undefined} aria-label={showList ? undefined : current.label} className="flex min-h-0 min-w-0 flex-1 flex-col">
            <header className="flex h-12 flex-none items-center gap-2 border-b border-line px-5 max-md:px-2">
              {!desktop && (
                <button type="button" className="icon-btn !h-11 !w-11 flex-none" aria-label="시스템 설정 목록으로" onClick={() => setView("list")}><span className="rotate-90"><ChevronIcon size={18} /></span></button>
              )}
              <h2 ref={title} tabIndex={-1} className="min-w-0 truncate text-l font-semibold outline-none max-md:flex-1 max-md:text-center">{current.label}</h2>
              <span className="flex-1 max-md:hidden" />
              <button type="button" className="icon-btn flex-none max-md:!h-11 max-md:!w-11" aria-label="닫기" onClick={close}><CloseIcon /></button>
            </header>
            <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5 pt-4 max-md:px-4">
              {current.id === "collector" ? <CollectorBoard /> : current.id === "account" ? <PublicAccountMenu /> : <HotkeysMenuContent />}
            </div>
          </section>
        )}
      </div>
    </DialogFrame>
  );
}
