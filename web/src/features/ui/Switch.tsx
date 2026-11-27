import type { ReactNode } from "react";

interface SwitchProps {
  checked: boolean;
  onChange(checked: boolean): void;
  label?: ReactNode;
  ariaLabel?: string;
  ariaDescribedBy?: string;
  disabled?: boolean;
  size?: "sm" | "md";
  title?: string;
  className?: string;
  testId?: string;
}

export function Switch({
  checked,
  onChange,
  label,
  ariaLabel,
  ariaDescribedBy,
  disabled = false,
  size = "md",
  title,
  className = "",
  testId,
}: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      aria-describedby={ariaDescribedBy}
      data-size={size === "sm" ? "sm" : undefined}
      data-testid={testId}
      disabled={disabled}
      title={title}
      className={className ? `ui-switch ${className}` : "ui-switch"}
      onClick={() => onChange(!checked)}
    >
      {label !== undefined && (typeof label === "string" ? <span className="min-w-0 flex-1 text-left">{label}</span> : label)}
      <span aria-hidden="true" className="ui-switch-track"><span /></span>
    </button>
  );
}
