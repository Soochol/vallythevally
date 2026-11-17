import { useEffect, useState } from "react";
import { startLogin } from "../../api/account";
import type { AccountProvider } from "../../api/generated/AccountProvider";
import { useAccountStore } from "../../stores/account";
import { PROVIDER_NAME } from "./provider";

const PROVIDER_BUTTON = "h-11 w-full rounded-m border border-line bg-raised px-4 text-m font-semibold text-text hover:bg-hover disabled:opacity-60";

export function LoginScreen() {
  const [failure] = useState(() => useAccountStore.getState().loginFailure);
  const [leaving, setLeaving] = useState<AccountProvider | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => useAccountStore.getState().showLoginFailure(null), []);

  const login = async (provider: AccountProvider) => {
    setLeaving(provider);
    setError(null);
    try {
      window.location.assign((await startLogin(provider)).url);
    } catch (e) {
      setError(e instanceof Error ? e.message : "로그인을 시작하지 못했습니다");
      setLeaving(null);
    }
  };

  return (
    <main aria-label="로그인" className="grid min-h-dvh place-items-center bg-bg p-4">
      <div className="flex w-full max-w-[400px] flex-col gap-4 rounded-m border border-line bg-surface p-6">
        <h1 className="text-l font-semibold">로그인</h1>
        {failure && <p role="status" className="text-m text-text-2">{failure}</p>}
        {error && <p role="alert" className="text-m text-danger">{error}</p>}
        <div className="flex flex-col gap-2">
          {(["google", "naver"] as const).map((provider) => (
            <button key={provider} type="button" className={PROVIDER_BUTTON} disabled={leaving !== null} onClick={() => void login(provider)}>
              {PROVIDER_NAME[provider]}로 로그인
            </button>
          ))}
        </div>
        <p className="text-s text-text-3">로그인한 계정의 고유 번호만 받습니다. 이메일과 이름은 받지 않습니다.</p>
        <p className="text-s text-text-3">Google과 네이버는 서로 다른 계정입니다. 같은 사람이어도 셋업이 따로 저장됩니다.</p>
      </div>
    </main>
  );
}
