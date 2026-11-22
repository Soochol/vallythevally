import { useState } from "react";
import { startLogin } from "../../api/account";
import type { AccountProvider } from "../../api/generated/AccountProvider";
import { loginStartPath } from "../../public-mode/session";
import { isPublicMode } from "../../public-mode/serverMode";
import { markLoginStarted } from "../setup-wizard/wizardOpen";

export function useLoginStart() {
  const [leaving, setLeaving] = useState<AccountProvider | null>(null);
  const [error, setError] = useState<string | null>(null);

  const login = async (provider: AccountProvider) => {
    setLeaving(provider);
    setError(null);
    try {
      const url = isPublicMode() ? loginStartPath(provider) : (await startLogin(provider)).url;
      markLoginStarted();
      window.location.assign(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : "로그인을 시작하지 못했습니다");
      setLeaving(null);
    }
  };

  return { leaving, error, login };
}
