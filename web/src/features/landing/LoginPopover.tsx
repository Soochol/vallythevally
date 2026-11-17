import { type RefObject, useState } from "react";
import { startLogin } from "../../api/account";
import type { AccountProvider } from "../../api/generated/AccountProvider";
import { markLoginStarted } from "../setup-wizard/wizardOpen";
import { Popover } from "../overlay/Popover";
import { PROVIDER_NAME } from "../account/provider";

const PROVIDER_BUTTON = "h-11 w-full rounded-m border border-line bg-raised px-4 text-left text-m font-semibold text-text hover:bg-hover disabled:opacity-60";
const PROVIDERS = ["google", "naver"] as const;

interface Props {
  anchor: RefObject<HTMLElement | null>;
  failure: string | null;
  onClose(): void;
}

export function LoginPopover({ anchor, failure, onClose }: Props) {
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

  return (
    <Popover role="dialog" aria-label="로그인" anchor={anchor} placement="bottom" onClose={onClose} className="flex w-[300px] flex-col gap-3 p-4">
      <h2 className="text-l font-semibold">로그인</h2>
      {failure && <p role="status" className="text-m text-text-2">{failure}</p>}
      {error && <p role="alert" className="text-m text-danger">{error}</p>}
      <div className="flex flex-col gap-2">
        {PROVIDERS.map((provider) => (
          <button key={provider} type="button" className={PROVIDER_BUTTON} disabled={leaving !== null} onClick={() => void login(provider)}>
            {PROVIDER_NAME[provider]}로 로그인
          </button>
        ))}
      </div>
      {leaving && <p role="status" className="text-m text-accent">{PROVIDER_NAME[leaving]} 로그인 화면으로 이동합니다</p>}
      <p className="text-s text-text-3">로그인한 계정의 고유 번호만 받습니다. 이메일과 이름은 받지 않습니다.</p>
      <p className="text-s text-text-3">Google과 네이버는 서로 다른 계정입니다. 같은 사람이어도 셋업이 따로 저장됩니다.</p>
    </Popover>
  );
}
