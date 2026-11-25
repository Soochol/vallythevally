import { useRef, useState } from "react";
import { Popover } from "../overlay/Popover";

export function HelpTip({ label, text }: { label: string; text: string }) {
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="etf-help"
        aria-label={label}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={(event) => {
          event.stopPropagation();
          setOpen((prev) => !prev);
        }}
      >
        ?
      </button>
      {open && (
        <Popover
          anchor={trigger}
          solid
          placement="bottom"
          blockChartKeys={false}
          restoreFocus={false}
          role="dialog"
          aria-label={label}
          className="etf-help-popover"
          onKeyDown={(event) => {
            if (event.key === "Tab") setOpen(false);
          }}
          onClose={(reason) => {
            setOpen(false);
            if (reason === "escape") trigger.current?.focus();
          }}
        >
          <p className="etf-help-text">{text}</p>
        </Popover>
      )}
    </>
  );
}
