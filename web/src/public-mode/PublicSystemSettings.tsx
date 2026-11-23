import { useId, useState } from "react";
import { collectorAllowed, useCollectorAccess } from "../api/collector";
import { DialogFrame } from "../features/dialog/DialogParts";
import { CollectorBoard } from "../features/collector-board/CollectorBoard";
import { CloseIcon } from "../features/icons";
import { HotkeysMenuContent } from "../features/system-settings/HotkeysMenuContent";
import { cancelHotkeyRecording } from "../features/system-settings/hotkeyRecording";
import type { SystemMenuId } from "../features/system-settings/menus";
import { useSelectionStore } from "../stores/selection";
import { BrowserKeys } from "./keys/BrowserKeys";
import { PublicAccountMenu } from "./PublicAccountMenu";

type PublicMenuId = Extract<SystemMenuId, "kiwoom" | "hotkeys" | "collector" | "account">;

const MENUS: readonly { id: PublicMenuId; label: string }[] = [
  { id: "kiwoom", label: "증권사 · 계좌" },
  { id: "hotkeys", label: "단축키" },
  { id: "collector", label: "수집 현황판" },
  { id: "account", label: "계정" },
];

export function PublicSystemSettings({ menu }: { menu: SystemMenuId | null }) {
  const close = useSelectionStore((s) => s.closeDialog);
  const ids = useId();
  const collector = collectorAllowed(useCollectorAccess());
  const menus = MENUS.filter((m) => m.id !== "collector" || collector);
  const [selected, setSelected] = useState<PublicMenuId>(() => MENUS.find((m) => m.id === menu)?.id ?? "kiwoom");
  const current = menus.find((m) => m.id === selected) ?? menus[0]!;

  return (
    <DialogFrame labelledBy={`${ids}-title`} width="h-[min(680px,calc(100dvh-48px))] w-[min(940px,calc(100vw-48px))] max-md:h-[85dvh]" onClose={(reason) => { if (reason !== "outside" && cancelHotkeyRecording()) return; close(); }}>
      <div className="flex min-h-0 flex-1 max-md:flex-col">
        <h2 id={`${ids}-title`} className="sr-only">시스템 설정</h2>
        <nav aria-label="시스템 설정 메뉴" className="flex w-[208px] flex-none flex-col gap-1 border-r border-line p-3 max-md:w-full max-md:border-b max-md:border-r-0 max-md:p-2">
          <span aria-hidden="true" className="px-2 pb-2 pt-1 text-m font-semibold max-md:hidden">시스템 설정</span>
          <div role="tablist" aria-orientation="vertical" aria-label="시스템 설정 메뉴" className="flex flex-col gap-0.5 max-md:flex-row max-md:overflow-x-auto">
            {menus.map((m) => (
              <button key={m.id} type="button" role="tab" aria-selected={m.id === current.id} aria-controls={`${ids}-panel`} onClick={() => setSelected(m.id)} className="flex h-9 flex-none items-center rounded-m px-2 text-left text-text-2 hover:bg-hover hover:text-text aria-selected:bg-hover aria-selected:font-semibold aria-selected:text-text">
                <span className="min-w-0 flex-1 truncate">{m.label}</span>
              </button>
            ))}
          </div>
        </nav>
        <section role="tabpanel" id={`${ids}-panel`} aria-label={current.label} className="flex min-h-0 min-w-0 flex-1 flex-col">
          <header className="flex h-12 flex-none items-center gap-2 px-5 max-md:px-4">
            <h2 className="min-w-0 flex-1 truncate text-l font-semibold">{current.label}</h2>
            <button type="button" className="icon-btn flex-none" aria-label="닫기" onClick={close}><CloseIcon /></button>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5 max-md:px-4">
            {current.id === "kiwoom" ? <BrowserKeys /> : current.id === "collector" ? <CollectorBoard /> : current.id === "account" ? <PublicAccountMenu /> : <HotkeysMenuContent />}
          </div>
        </section>
      </div>
    </DialogFrame>
  );
}
