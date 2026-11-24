import { bookReplayAvailable, useBookReplayAccess } from "../../api/bookReplay";
import { useBookReplayStore } from "../../stores/bookReplay";
import { useBookReplayPref, useUiStore } from "../../stores/ui";
import { ClockIcon } from "../icons";

export function BookReplayToggle() {
  const access = useBookReplayAccess();
  const enabled = useBookReplayPref();
  const setBookReplay = useUiStore((state) => state.setBookReplay);
  if (!bookReplayAvailable(access)) return null;
  const toggle = () => {
    const next = !enabled;
    setBookReplay(next);
    if (!next) useBookReplayStore.getState().clear();
  };
  return (
    <button
      type="button"
      className="tb-btn book-replay-toggle"
      aria-label="호가 복기"
      aria-pressed={enabled}
      title="호가 복기"
      onClick={toggle}
    >
      <ClockIcon size={16} />
      <span className="topbar-label-xl">호가 복기</span>
    </button>
  );
}
