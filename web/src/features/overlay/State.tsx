import type { ReactNode } from "react";
export function Skeleton({ label = "불러오는 중" }: { label?: string }) {
  return <div role="status" aria-label={label} className="ui-state ui-skeleton"><span /><span /><span /><span className="sr-only">{label}</span></div>;
}
export function EmptyState({ title, children, action, onAction }: { title: string; children?: ReactNode; action?: string; onAction?: () => void }) {
  return <div className="ui-state"><p>{title}</p>{children}{action && onAction && <button className="tb-btn" onClick={onAction}>{action}</button>}</div>;
}
export function ErrorState({ message, retry }: { message: string; retry(): void }) {
  return <div role="alert" className="ui-state"><p>{message}</p><button className="tb-btn" onClick={retry}>다시 시도</button></div>;
}
