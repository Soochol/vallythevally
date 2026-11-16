import { WINDOW_KINDS } from "../../layout/kinds";
import { linkLabel, nextLink, useLayoutStore, type WindowState } from "../../stores/layout";

export function LinkDot({ window, selected }: { window: WindowState; selected: boolean }) {
  if (WINDOW_KINDS[window.kind].link === "none") return null;
  const value = window.link === null ? "끔" : linkLabel(window.link);
  return (
    <button type="button" className="link-dot" tabIndex={selected ? 0 : -1} data-link={window.link ?? undefined} aria-label={`연동 색: ${value}`} title={`연동 색: ${value} · 누르면 바뀝니다`}
      onClick={() => useLayoutStore.getState().setLink(window.id, nextLink(window.link))}>
      {window.link !== null && <span aria-hidden="true">{value}</span>}
    </button>
  );
}
