import type { CSSProperties, ReactNode } from "react";
import { EmptyBoxIcon, WarningIcon } from "../icons";

export type SkeletonShape = "line" | "card" | "chart" | "row";

const SKELETON_ROWS: Record<SkeletonShape, number> = { line: 3, card: 3, chart: 1, row: 6 };

export function Skeleton({ label = "불러오는 중", rows, shape = "line", minHeight }: { label?: string; rows?: number; shape?: SkeletonShape; minHeight?: number | string }) {
  const style: CSSProperties | undefined = minHeight === undefined ? undefined : { minHeight };
  return (
    <div role="status" aria-label={label} data-shape={shape} style={style} className="ui-state ui-skeleton">
      {Array.from({ length: rows ?? SKELETON_ROWS[shape] }, (_, index) => <span key={index} />)}
      <span className="sr-only">{label}</span>
    </div>
  );
}

export function EmptyState({ title, children, action, onAction, icon }: { title: string; children?: ReactNode; action?: string; onAction?: () => void; icon?: ReactNode }) {
  return (
    <div className="ui-state">
      <span className="ui-state-icon">{icon ?? <EmptyBoxIcon />}</span>
      <p className="ui-state-title">{title}</p>
      {children && <div className="ui-state-body">{children}</div>}
      {action && onAction && <button type="button" className="btn" onClick={onAction}>{action}</button>}
    </div>
  );
}

export function ErrorState({ message, retry, detail, icon, children }: { message: string; retry(): void; detail?: string; icon?: ReactNode; children?: ReactNode }) {
  return (
    <div role="alert" className="ui-state" data-tone="danger">
      <span className="ui-state-icon">{icon ?? <WarningIcon size={24} />}</span>
      <p className="ui-state-title">{message}</p>
      {children && <div className="ui-state-body">{children}</div>}
      <button type="button" className="btn" onClick={retry}>다시 시도</button>
      {detail && <details className="ui-state-detail"><summary>자세히</summary><pre>{detail}</pre></details>}
    </div>
  );
}
