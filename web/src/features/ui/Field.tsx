import { type InputHTMLAttributes, type ReactNode, useId, useRef, useState } from "react";
import { EyeIcon } from "../icons";

interface FieldCommon {
  label: string;
  help?: string;
  error?: string;
  layout?: "stack" | "inline";
}

export const trimSecret = (text: string): string => text.trim();

function useFieldIds(id: string | undefined, help: string | undefined, error: string | undefined, describedBy: string | undefined) {
  const generated = useId();
  const inputId = id ?? generated;
  const helpId = `${inputId}-help`;
  const errorId = `${inputId}-error`;
  const described = [describedBy, error ? errorId : undefined, help ? helpId : undefined].filter((part): part is string => part !== undefined).join(" ");
  return { inputId, helpId, errorId, described: described === "" ? undefined : described };
}

interface ShellProps extends FieldCommon { inputId: string; helpId: string; errorId: string; children: ReactNode }

function FieldShell({ label, help, error, layout = "stack", inputId, helpId, errorId, children }: ShellProps) {
  return (
    <div className="ui-field-wrap" data-layout={layout}>
      <label htmlFor={inputId} className="ui-field-label">{label}</label>
      <div className="ui-field-body">
        {children}
        {error && <p id={errorId} className="ui-field-error">{error}</p>}
        {help && <p id={helpId} className="ui-field-help">{help}</p>}
      </div>
    </div>
  );
}

type FieldProps = FieldCommon & Omit<InputHTMLAttributes<HTMLInputElement>, "children">;

export function Field({ label, help, error, layout, id, className = "", "aria-describedby": describedBy, ...input }: FieldProps) {
  const ids = useFieldIds(id, help, error, describedBy);
  return (
    <FieldShell label={label} help={help} error={error} layout={layout} inputId={ids.inputId} helpId={ids.helpId} errorId={ids.errorId}>
      <input {...input} id={ids.inputId} aria-invalid={error ? true : undefined} aria-describedby={ids.described} className={`ui-field ${className}`} />
    </FieldShell>
  );
}

type SecretFieldProps = FieldCommon & Omit<InputHTMLAttributes<HTMLInputElement>, "children" | "type" | "value" | "onChange"> & {
  value: string;
  onChange(value: string): void;
};

export function SecretField({ label, help, error, layout, id, value, onChange, className = "", "aria-describedby": describedBy, onBlur, ...input }: SecretFieldProps) {
  const ids = useFieldIds(id, help, error, describedBy);
  const field = useRef<HTMLInputElement>(null);
  const [shown, setShown] = useState(false);
  const paste = () => {
    navigator.clipboard.readText().then((text) => onChange(trimSecret(text)), () => field.current?.focus());
  };
  return (
    <FieldShell label={label} help={help} error={error} layout={layout} inputId={ids.inputId} helpId={ids.helpId} errorId={ids.errorId}>
      <div className="ui-field-cell">
        <input
          {...input}
          ref={field}
          id={ids.inputId}
          type={shown ? "text" : "password"}
          value={value}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          aria-invalid={error ? true : undefined}
          aria-describedby={ids.described}
          className={`ui-field ${className}`}
          onChange={(event) => onChange(event.target.value)}
          onBlur={(event) => {
            if (trimSecret(value) !== value) onChange(trimSecret(value));
            onBlur?.(event);
          }}
        />
        <span className="ui-field-actions">
          <button type="button" className="btn-ghost btn-sm" aria-pressed={shown} aria-label={shown ? "숨기기" : "보기"} onClick={() => setShown(!shown)}><EyeIcon off={shown} /></button>
          <button type="button" className="btn-ghost btn-sm" disabled={input.disabled} onClick={paste}>붙여넣기</button>
        </span>
      </div>
    </FieldShell>
  );
}
