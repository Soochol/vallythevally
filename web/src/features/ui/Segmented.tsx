import { type KeyboardEvent, type ReactNode, useRef } from "react";
import { rovingTarget } from "./roving";

export interface SegmentedOption<T extends string> { value: T; label: ReactNode; disabled?: boolean; title?: string }

interface Props<T extends string> {
  label: string;
  options: readonly SegmentedOption<T>[];
  value: T | null;
  onChange(value: T): void;
  mode?: "radio" | "pressed";
  size?: "sm" | "md";
  className?: string;
}

export function Segmented<T extends string>({ label, options, value, onChange, mode = "radio", size = "md", className = "" }: Props<T>) {
  const group = useRef<HTMLDivElement>(null);
  const radio = mode === "radio";
  const selectedIndex = options.findIndex((option) => option.value === value && !option.disabled);
  const entryIndex = selectedIndex >= 0 ? selectedIndex : options.findIndex((option) => !option.disabled);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!radio || event.nativeEvent.isComposing) return;
    const current = options.findIndex((_, index) => group.current?.children[index] === document.activeElement);
    const target = rovingTarget(options.map((option) => option.disabled === true), current, event.key);
    if (target === null) return;
    event.preventDefault();
    (group.current?.children[target] as HTMLElement | undefined)?.focus();
    onChange(options[target]!.value);
  };

  return (
    <div ref={group} role={radio ? "radiogroup" : "group"} aria-label={label} data-size={size} className={`ui-seg ${className}`} onKeyDown={onKeyDown}>
      {options.map((option, index) => {
        const chosen = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role={radio ? "radio" : undefined}
            aria-checked={radio ? chosen : undefined}
            aria-pressed={radio ? undefined : chosen}
            tabIndex={radio && index !== entryIndex ? -1 : undefined}
            disabled={option.disabled}
            title={option.title}
            className="ui-seg-item"
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
