import { keyCapsLabel, searchTitle } from "../../lib/hotkeys";
import { useSelectionStore } from "../../stores/selection";
import { useActionKeys } from "../../stores/ui";
import { SearchIcon } from "../icons";
import { setPageSlot } from "../pages/pageSlot";
import { SystemButton } from "../system-settings/SystemButton";
import { MockBadge } from "../topbar/MockBadge";
import { BrandLink } from "./BrandLink";

export function PageTopbar() {
  const keys = useActionKeys();
  const openSearch = useSelectionStore((s) => s.openSearch);
  return (
    <header role="toolbar" aria-label="페이지 도구 막대" className="desktop-topbar page-topbar ui-island relative z-20 mx-[var(--island-gap)] mt-[var(--island-gap)] h-[var(--island-h)] flex-none rounded-l max-md:hidden">
      <div className="topbar-zone" data-zone="app">
        <BrandLink />
        <MockBadge />
      </div>
      <span className="tb-sep" />
      <div ref={setPageSlot} className="page-topbar-slot" />
      <button type="button" className="tb-btn page-find" aria-haspopup="dialog" aria-label="종목 찾기" title={searchTitle(keys)} onClick={() => openSearch("page")}>
        <SearchIcon size={14} />
        <span className="topbar-label-lg">종목 찾기</span>
        {keys.search?.slice(0, 1).map((key) => <kbd key={key}>{keyCapsLabel(key)}</kbd>)}
      </button>
      <SystemButton />
    </header>
  );
}
