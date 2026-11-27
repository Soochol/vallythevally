import { Popover } from "../overlay/Popover";
import { type CSSProperties, type ReactNode, type Ref, useState } from "react";

const FOCUSABLE = "button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea, [tabindex='0']";

function onDialogKeyDown(e: React.KeyboardEvent<HTMLElement>, close: (reason?: "escape" | "outside") => void) {
  if (e.nativeEvent.isComposing || e.keyCode === 229) {
    if (e.key === "Enter") e.preventDefault();
    return;
  }
  if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    close("escape");
  } else if (e.key === "Tab") {
    const nodes = [...e.currentTarget.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((n) => n.tabIndex >= 0 && n.getClientRects().length > 0);
    const first = nodes[0];
    const last = nodes.at(-1);
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last?.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first?.focus();
    }
  }
}

interface FrameProps {
  labelledBy: string;
  width: string;
  onClose(reason?: "escape" | "outside"): void;
  panelRef?: Ref<HTMLDivElement>;
  panelStyle?: CSSProperties;
  variant?: "command" | "drawer";
  size?: "default" | "compact";
  solid?: boolean;
  scrim?: boolean;
  placement?: "center" | "top-end";
  children: ReactNode;
}

const OPEN_FRAME = ".ui-dialog-backdrop:not([data-command-frame])";

export function DialogFrame({ labelledBy, width, onClose, panelRef, panelStyle, children, variant, size = "default", solid, scrim = true, placement = "center" }: FrameProps) {
  const [nested] = useState(() => typeof document !== "undefined" && document.querySelector(OPEN_FRAME) !== null);
  return (
    <Popover backdrop data-command-frame={variant === "command" ? "" : undefined} data-drawer={variant === "drawer" ? "" : undefined} data-nested={nested ? "" : undefined} data-no-scrim={scrim ? undefined : ""} data-placement={placement === "center" ? undefined : placement} onClose={onClose}
      className={`ui-dialog-backdrop fixed inset-0 flex justify-center${scrim ? " bg-[var(--scrim)]" : ""}`}
    >
      <div
        ref={panelRef}
        style={panelStyle}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        data-drawer={variant === "drawer" ? "" : undefined}
        data-size={size === "compact" ? "compact" : undefined}
        data-solid={solid ? "" : undefined}
        tabIndex={-1}
        onKeyDown={(e) => onDialogKeyDown(e, onClose)}
        className={
          `ui-dialog flex ${width} flex-col overflow-hidden rounded-l outline-none ` +
          "max-md:max-h-[85dvh] max-md:w-screen max-md:rounded-b-none"
        }
      >
        {children}
      </div>
    </Popover>
  );
}

export function Row({ label, labelFor, children }: { label: string; labelFor?: string; children: ReactNode }) {
  const caption = "text-s leading-[30px] text-text-2 max-sm:leading-snug";
  return (
    <div className="grid grid-cols-[92px_minmax(0,1fr)] items-start gap-3 max-sm:grid-cols-1 max-sm:gap-1">
      {labelFor ? (
        <label htmlFor={labelFor} className={caption}>
          {label}
        </label>
      ) : (
        <span className={caption}>{label}</span>
      )}
      <div className="flex min-w-0 flex-col gap-1">{children}</div>
    </div>
  );
}

export function Errors({ id, messages }: { id: string; messages: readonly string[] }) {
  if (messages.length === 0) return null;
  return (
    <p id={id} role="alert" className="text-s text-danger">
      {messages.join(" ")}
    </p>
  );
}
