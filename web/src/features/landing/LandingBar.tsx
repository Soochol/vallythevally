import { useRef, useState } from "react";
import { Link } from "react-router";
import { BrandIcon } from "../icons";
import { pathOfPage } from "../page-rail/pages";
import { LoginPopover } from "./LoginPopover";
import { useLoginStart } from "./useLoginStart";

export function LandingBar({ initialFailure, signedOut }: { initialFailure: string | null; signedOut: boolean }) {
  const [open, setOpen] = useState(initialFailure !== null);
  const button = useRef<HTMLButtonElement>(null);
  const { leaving, error, login } = useLoginStart();
  return (
    <header className="landing-bar">
      <span className="flex items-center gap-2 text-xl font-bold tracking-tight">
        <span className="text-accent"><BrandIcon size={24} /></span>
        vally
      </span>
      {signedOut ? (
        <button ref={button} type="button" aria-expanded={open} className="landing-login" onClick={() => setOpen((value) => !value)}>
          로그인
        </button>
      ) : (
        <Link to={pathOfPage("workspace")} className="landing-login">작업 영역 열기</Link>
      )}
      {signedOut && open && <LoginPopover anchor={button} failure={initialFailure} leaving={leaving} error={error} onLogin={(provider) => void login(provider)} onClose={() => setOpen(false)} />}
    </header>
  );
}
