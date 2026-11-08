import { useSelectionStore } from "../../stores/selection";
import { ChartIcon, SearchIcon } from "../icons";

/** 휴대폰 아래 탭. #2에는 차트와 검색만 있다(관심종목은 #3). */
export function PhoneTabs() {
  const searching = useSelectionStore((s) => s.dialog?.kind === "search");
  const { openDialog, closeDialog } = useSelectionStore.getState();
  const tab = "flex flex-col items-center justify-center gap-0.5 text-xs text-text-3 aria-pressed:text-accent";
  return (
    <nav aria-label="휴대폰 탭" className="hidden grid-cols-2 border-t border-line bg-bg [grid-area:mtabs] max-md:grid">
      <button type="button" className={tab} aria-pressed={!searching} onClick={closeDialog}>
        <ChartIcon size={22} />
        차트
      </button>
      <button type="button" className={tab} aria-pressed={searching} onClick={() => openDialog("search")}>
        <SearchIcon size={22} />
        검색
      </button>
    </nav>
  );
}
