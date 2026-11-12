import { Popover } from "../overlay/Popover";
import { type ReactNode, type Ref } from "react";

const FOCUSABLE = "button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea, [tabindex='0']";

function onDialogKeyDown(e: React.KeyboardEvent<HTMLElement>, close: () => void) {
  if (e.nativeEvent.isComposing || e.keyCode === 229) {
    if (e.key === "Enter") e.preventDefault();
    return;
  }
  if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    close();
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
  onClose(): void;
  panelRef?: Ref<HTMLDivElement>;
  variant?: "command";
  children: ReactNode;
}

export function DialogFrame({ labelledBy, width, onClose, panelRef, children, variant }: FrameProps) {
  return (
    <Popover backdrop data-command-frame={variant === "command" ? "" : undefined} onClose={onClose}
      className="ui-dialog-backdrop fixed inset-0 z-50 flex justify-center bg-[var(--scrim)]"
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        tabIndex={-1}
        onKeyDown={(e) => onDialogKeyDown(e, onClose)}
        className={
          `ui-dialog flex ${width} flex-col overflow-hidden rounded-l border border-line bg-surface shadow-dialog outline-none ` +
          "max-md:max-h-[85dvh] max-md:w-screen max-md:rounded-b-none"
        }
      >
        {children}
      </div>
    </Popover>
  );
}

export function Row({ label, labelFor, children }: { label: string; labelFor?: string; children: ReactNode }) {
  const caption = "text-s leading-[30px] text-text-2";
  return (
    <div className="grid grid-cols-[92px_minmax(0,1fr)] items-start gap-3">
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

export function Segment<T extends string | number>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: readonly (readonly [T, string])[];
  value: T | string;
  onChange(v: T): void;
}) {
  return (
    <div role="group" aria-label={label} className="inline-flex w-max overflow-hidden rounded-m border border-line">
      {options.map(([v, text]) => (
        <button
          key={v}
          type="button"
          aria-pressed={v === value}
          onClick={() => onChange(v)}
          className="h-9 border-r border-line px-3 text-text-2 last:border-r-0 hover:text-text aria-pressed:bg-accent-soft aria-pressed:font-semibold aria-pressed:text-accent"
        >
          {text}
        </button>
      ))}
    </div>
  );
}

export function Errors({ id, messages }: { id: string; messages: readonly string[] }) {
  if (messages.length === 0) return null;
  return (
    <p id={id} className="text-s text-danger">
      {messages.join(" ")}
    </p>
  );
}
