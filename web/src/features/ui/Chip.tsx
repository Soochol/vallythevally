import type { ButtonHTMLAttributes, ReactNode } from "react";

interface Props extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onChange" | "aria-pressed"> {
  pressed: boolean;
  onPressedChange(next: boolean): void;
  children: ReactNode;
}

export function Chip({ pressed, onPressedChange, children, className = "", onClick, ...rest }: Props) {
  return (
    <button
      type="button"
      {...rest}
      aria-pressed={pressed}
      className={className ? `ui-chip ${className}` : "ui-chip"}
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented) onPressedChange(!pressed);
      }}
    >
      {children}
    </button>
  );
}
