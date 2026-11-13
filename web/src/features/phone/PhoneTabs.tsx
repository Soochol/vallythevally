import { type PhoneTab, useSelectionStore } from "../../stores/selection";
import { ChartIcon, FunnelIcon, ListIcon, SearchIcon } from "../icons";

export function PhoneTabs() {
  const searching = useSelectionStore((s) => s.dialog?.kind === "search");
  const tab = useSelectionStore((s) => s.phoneTab);
  const { openSearch, closeDialog, setPhoneTab } = useSelectionStore.getState();
  const show = (t: PhoneTab) => {
    closeDialog();
    setPhoneTab(t);
  };
  const cls = "flex flex-col items-center justify-center gap-0.5 text-xs text-text-3 aria-pressed:text-accent";
  return (
    <nav aria-label="휴대폰 탭" className="ui-island mx-auto my-1 hidden w-[min(calc(100%-1.5rem),22rem)] grid-cols-4 rounded-[var(--r-pill)] [grid-area:mtabs] max-md:grid">
      <button type="button" className={cls} aria-pressed={!searching && tab === "chart"} onClick={() => show("chart")}>
        <ChartIcon size={22} />
        차트
      </button>
      <button type="button" className={cls} aria-pressed={!searching && tab === "watch"} onClick={() => show("watch")}>
        <ListIcon size={22} />
        관심종목
      </button>
      <button type="button" className={cls} aria-pressed={!searching && tab === "screener"} onClick={() => show("screener")}>
        <FunnelIcon size={22} />
        스크리너
      </button>
      <button type="button" className={cls} aria-pressed={searching} onClick={() => openSearch()}>
        <SearchIcon size={22} />
        검색
      </button>
    </nav>
  );
}
