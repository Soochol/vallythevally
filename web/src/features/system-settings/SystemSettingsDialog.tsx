import { type KeyboardEvent, useEffect, useId, useReducer, useRef } from "react";
import { PublicSystemSettings } from "../../public-mode/PublicSystemSettings";
import { usePublicMode } from "../../public-mode/serverMode";
import { collectorAllowed, useCollectorAccess } from "../../api/collector";
import { DESKTOP_QUERY, useMediaQuery } from "../../lib/media";
import { useKiwoomKeys } from "../../api/system";
import { useKiwoomLinkStore } from "../../stores/kiwoomLink";
import { useSelectionStore } from "../../stores/selection";
import { DialogFrame } from "../dialog/DialogParts";
import { AccountMenuContent } from "../account/AccountMenuContent";
import { CollectorBoard } from "../collector-board/CollectorBoard";
import { CloseIcon } from "../icons";
import { HotkeysMenuContent } from "./HotkeysMenuContent";
import { cancelHotkeyRecording } from "./hotkeyRecording";
import { KiwoomMenuContent } from "./KiwoomMenuContent";
import { KEY_LIST_REFRESH_MS, menuDotTone } from "./kiwoomKeys";
import { menuAfterKey, type SystemMenuId, visibleMenus } from "./menus";
import { focusTarget, navigate, openNavigation } from "./navigation";
import { ReadOnlyMenuContent } from "./ReadOnlyMenuContent";

export function SystemSettingsDialog() {
  const dialog = useSelectionStore((s) => s.dialog);
  const publicMode = usePublicMode();
  if (dialog?.kind !== "system-settings") return null;
  return publicMode ? <PublicSystemSettings menu={dialog.menu} /> : <SystemSettingsBody menu={dialog.menu} />;
}

function SystemSettingsBody({ menu }: { menu: SystemMenuId | null }) {
  const close = useSelectionStore((s) => s.closeDialog);
  const desktop = useMediaQuery(DESKTOP_QUERY);
  const ids = useId();
  const [{ selected, view }, dispatch] = useReducer(navigate, menu, openNavigation);
  const tone = menuDotTone(useKiwoomLinkStore((s) => s.status), useKiwoomKeys(KEY_LIST_REFRESH_MS).data?.keys);
  const title = useRef<HTMLHeadingElement>(null);
  const tabId = (id: SystemMenuId) => `${ids}-tab-${id}`;
  const showList = desktop || view === "list";
  const showContent = desktop || view === "content";
  const menus = visibleMenus(collectorAllowed(useCollectorAccess()));
  const current = menus.find((m) => m.id === selected) ?? menus[0]!;

  useEffect(() => {
    const target = focusTarget({ selected, view }, desktop);
    if (target.kind === "title") title.current?.focus();
    else document.getElementById(tabId(target.menu))?.focus();
  }, [view, desktop]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const next = menuAfterKey(current.id, e.key, menus);
    if (!next) return;
    e.preventDefault();
    dispatch({ type: "move", menu: next });
    document.getElementById(tabId(next))?.focus();
  };

  return (
    <DialogFrame labelledBy={`${ids}-title`} width="h-[min(680px,calc(100dvh-48px))] w-[min(940px,calc(100vw-48px))] max-md:h-[85dvh]" onClose={(reason) => { if (reason !== "outside" && cancelHotkeyRecording()) return; close(); }}>
      <div className="flex min-h-0 flex-1 max-md:flex-col">
        <h2 id={`${ids}-title`} className="sr-only">시스템 설정</h2>
        {showList && (
          <nav aria-label="시스템 설정 메뉴" className="flex w-[208px] flex-none flex-col gap-1 border-r border-line p-3 max-md:w-full max-md:flex-1 max-md:overflow-y-auto max-md:border-r-0 max-md:p-0">
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
                  disabled={!m.ready}
                  aria-selected={m.id === current.id}
                  aria-controls={showContent ? `${ids}-panel` : undefined}
                  tabIndex={m.id === current.id ? 0 : -1}
                  onClick={() => dispatch({ type: "choose", menu: m.id })}
                  className="flex h-9 items-center gap-2 rounded-m px-2 text-left text-text-2 hover:bg-hover hover:text-text disabled:cursor-not-allowed disabled:text-text-3 disabled:hover:bg-transparent aria-selected:bg-accent-soft aria-selected:font-semibold aria-selected:text-accent max-md:h-12 max-md:rounded-none max-md:border-t max-md:border-line max-md:px-4 max-md:aria-selected:bg-transparent max-md:aria-selected:text-text"
                >
                  <span className="min-w-0 flex-1 truncate">{m.label}</span>
                  {!m.ready && <span className="flex-none text-xs">준비 중</span>}
                  {m.id === "kiwoom" && <span aria-hidden="true" className="conn-dot" data-tone={tone} />}
                </button>
              ))}
            </div>
          </nav>
        )}
        {showContent && (
          <section role="tabpanel" id={`${ids}-panel`} aria-labelledby={showList ? tabId(current.id) : undefined} aria-label={showList ? undefined : current.label} className="flex min-h-0 min-w-0 flex-1 flex-col">
            <header className="flex h-12 flex-none items-center gap-2 px-5 max-md:px-2">
              {!desktop && (
                <button type="button" className="tb-btn px-2" onClick={() => dispatch({ type: "back" })}>‹ 시스템 설정</button>
              )}
              <h2 ref={title} tabIndex={-1} className="min-w-0 flex-1 truncate text-l font-semibold outline-none max-md:text-center">{current.label}</h2>
              <button type="button" className="icon-btn flex-none" aria-label="닫기" onClick={close}><CloseIcon /></button>
            </header>
            <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5 max-md:px-4">
              {current.id === "kiwoom" ? <KiwoomMenuContent /> : current.id === "collector" ? <CollectorBoard /> : current.id === "account" ? <AccountMenuContent /> : current.id === "hotkeys" ? <HotkeysMenuContent /> : current.id === "general" || current.id === "data" || current.id === "about" ? <ReadOnlyMenuContent menu={current.id} /> : null}
            </div>
          </section>
        )}
      </div>
    </DialogFrame>
  );
}
