import { type KeyboardEvent, type ReactNode, useRef } from "react";
import { rovingTarget } from "./roving";

export interface SegmentedOption<T extends string> { value: T; label: ReactNode; disabled?: boolean; title?: string }

interface Props<T extends string> {
  label: string;
  options: readonly SegmentedOption<T>[];
  value: T | null;
  onChange(value: T): void;
  mode?: "radio" | "pressed";
  size?: "xs" | "sm" | "md";
  variant?: "default" | "boxed";
  disabled?: boolean;
  className?: string;
}

export function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
  mode = "radio",
  size = "md",
  variant = "default",
  disabled = false,
  className = "",
}: Props<T>) {
  const group = useRef<HTMLDivElement>(null);
  const radio = mode === "radio";
  const isDisabled = (option: SegmentedOption<T>) => disabled || option.disabled === true;
  const selectedIndex = options.findIndex((option) => option.value === value && !isDisabled(option));
  const entryIndex = selectedIndex >= 0 ? selectedIndex : options.findIndex((option) => !isDisabled(option));

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing) return;
    const current = options.findIndex((_, index) => group.current?.children[index] === document.activeElement);
    const target = rovingTarget(options.map(isDisabled), current, event.key);
    if (target === null) return;
    event.preventDefault();
    (group.current?.children[target] as HTMLElement | undefined)?.focus();
    onChange(options[target]!.value);
  };

  return (
    <div
      ref={group}
      role={radio ? "radiogroup" : "group"}
      aria-label={label}
      data-size={size}
      data-variant={variant === "boxed" ? "boxed" : undefined}
      className={className ? `ui-seg ${className}` : "ui-seg"}
      onKeyDown={onKeyDown}
    >
      {options.map((option, index) => {
        const chosen = option.value === value;
        const itemDisabled = isDisabled(option);
        return (
          <button
            key={option.value}
            type="button"
            role={radio ? "radio" : undefined}
            aria-checked={radio ? chosen : undefined}
            aria-pressed={radio ? undefined : chosen}
            tabIndex={radio && index !== entryIndex ? -1 : undefined}
            disabled={itemDisabled}
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
