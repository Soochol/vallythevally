import { EmptyBoxIcon, WarningIcon } from "../icons";
import type { CellAction, CellErrorView } from "./cellError";

const ACTION_LABEL: Record<CellAction, string> = { search: "종목 검색", retry: "다시 시도", systemSettings: "시스템 설정 열기" };

export function CellState({ view, onAction }: { view: CellErrorView; onAction(action: CellAction): void }) {
  const missing = view.actions.includes("search");
  return (
    <div role="alert" className="ui-state" data-tone={missing ? undefined : "danger"}>
      <span className="ui-state-icon">{missing ? <EmptyBoxIcon /> : <WarningIcon size={24} />}</span>
      <p className="ui-state-title">{view.title}</p>
      {view.detail && <p className="ui-state-body">{view.detail}</p>}
      <div className="flex items-center justify-center gap-2">
        {view.actions.map((action) => <button key={action} type="button" className="btn" onClick={() => onAction(action)}>{ACTION_LABEL[action]}</button>)}
      </div>
    </div>
  );
}
