import { type KeyboardEvent, type ReactNode, useRef } from "react";
import { rovingTarget } from "./roving";

export interface TabItem { id: string; label: ReactNode; count?: number; disabled?: boolean; ariaLabel?: string }

export const tabDomId = (prefix: string, id: string): string => `${prefix}-tab-${id}`;
export const panelDomId = (prefix: string, id: string): string => `${prefix}-panel-${id}`;

interface Props {
  label: string;
  idPrefix: string;
  items: readonly TabItem[];
  value: string;
  onChange(id: string): void;
  className?: string;
}

export function Tabs({ label, idPrefix, items, value, onChange, className = "" }: Props) {
  const list = useRef<HTMLDivElement>(null);
  const entry = items.some((item) => item.id === value && !item.disabled) ? value : items.find((item) => !item.disabled)?.id;
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing) return;
    const current = items.findIndex((_, index) => list.current?.children[index] === document.activeElement);
    const target = rovingTarget(items.map((item) => item.disabled === true), current, event.key);
    if (target === null || event.key === "ArrowUp" || event.key === "ArrowDown") return;
    event.preventDefault();
    (list.current?.children[target] as HTMLElement | undefined)?.focus();
    onChange(items[target]!.id);
  };
  return (
    <div ref={list} role="tablist" aria-label={label} className={`ui-tabs ${className}`} onKeyDown={onKeyDown}>
      {items.map((item) => {
        const selected = item.id === value;
        return (
          <button
            key={item.id}
            id={tabDomId(idPrefix, item.id)}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-controls={panelDomId(idPrefix, item.id)}
            aria-label={item.ariaLabel}
            tabIndex={item.id === entry ? 0 : -1}
            disabled={item.disabled}
            onClick={() => onChange(item.id)}
          >
            {item.label}
            {item.count !== undefined && <span>{item.count}</span>}
          </button>
        );
      })}
    </div>
  );
}
