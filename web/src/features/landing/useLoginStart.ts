import { useState } from "react";
import { startLogin } from "../../api/account";
import type { AccountProvider } from "../../api/generated/AccountProvider";
import { markLoginStarted } from "../setup-wizard/wizardOpen";

export function useLoginStart() {
  const [leaving, setLeaving] = useState<AccountProvider | null>(null);
  const [error, setError] = useState<string | null>(null);

  const login = async (provider: AccountProvider) => {
    setLeaving(provider);
    setError(null);
    try {
      const { url } = await startLogin(provider);
      markLoginStarted();
      window.location.assign(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : "로그인을 시작하지 못했습니다");
      setLeaving(null);
    }
  };

  return { leaving, error, login };
}
