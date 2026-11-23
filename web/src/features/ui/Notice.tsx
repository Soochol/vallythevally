import type { ReactNode } from "react";
import { InfoIcon, WarningIcon } from "../icons";

export type NoticeTone = "info" | "warning" | "danger";

interface Props {
  tone?: NoticeTone;
  children: ReactNode;
  action?: { label: string; onClick(): void };
  className?: string;
}

export function Notice({ tone = "info", children, action, className = "" }: Props) {
  return (
    <div role={tone === "danger" ? "alert" : "status"} data-tone={tone} className={`ui-notice ${className}`}>
      {tone === "info" ? <InfoIcon /> : <WarningIcon />}
      <span className="ui-notice-text">{children}</span>
      {action && <button type="button" className="btn btn-sm" onClick={action.onClick}>{action.label}</button>}
    </div>
  );
}
