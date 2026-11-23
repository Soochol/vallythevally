import type { ButtonHTMLAttributes, ReactNode } from "react";

interface Props extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onChange" | "aria-pressed"> {
  pressed: boolean;
  onPressedChange(next: boolean): void;
  children: ReactNode;
}

export function Chip({ pressed, onPressedChange, children, className = "", ...rest }: Props) {
  return <button type="button" {...rest} aria-pressed={pressed} className={`ui-chip ${className}`} onClick={() => onPressedChange(!pressed)}>{children}</button>;
}
