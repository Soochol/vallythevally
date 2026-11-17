import { useRef, useState } from "react";
import { LoginPopover } from "./LoginPopover";

function LogoMark() {
  return (
    <svg aria-hidden="true" width="28" height="28" viewBox="0 0 28 28">
      <rect width="28" height="28" rx="8" fill="var(--accent)" />
      <path d="M7 9l7 11 7-11" fill="none" stroke="var(--accent-ink)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function LandingBar({ initialFailure }: { initialFailure: string | null }) {
  const [open, setOpen] = useState(initialFailure !== null);
  const button = useRef<HTMLButtonElement>(null);
  return (
    <header className="landing-bar">
      <span className="flex items-center gap-2.5 text-xl font-bold tracking-tight">
        <LogoMark />
        vally
      </span>
      <button ref={button} type="button" aria-expanded={open} className="landing-login" onClick={() => setOpen((value) => !value)}>
        로그인
      </button>
      {open && <LoginPopover anchor={button} failure={initialFailure} onClose={() => setOpen(false)} />}
    </header>
  );
}
