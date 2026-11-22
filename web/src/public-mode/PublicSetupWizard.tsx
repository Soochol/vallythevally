import { PROVIDER_NAME } from "../features/account/provider";
import { useWizardStore } from "../features/setup-wizard/wizardOpen";
import { useAccountStore } from "../stores/account";

export function PublicSetupWizard() {
  const account = useAccountStore((s) => s.status);
  const hide = useWizardStore((s) => s.hide);
  if (account?.state !== "signed_in") return null;
  return (
    <div role="dialog" aria-modal="true" aria-labelledby="setup-wizard-title" className="fixed inset-0 z-[60] overflow-y-auto bg-bg">
      <div className="mx-auto flex min-h-full w-full max-w-[640px] flex-col gap-4 px-4 py-6 md:py-10">
        <h1 id="setup-wizard-title" className="text-l font-semibold">처음 설정</h1>
        <p className="text-m text-text-2">{PROVIDER_NAME[account.provider]} 계정으로 로그인했습니다. 관심종목, 조건식, 레이아웃은 이 계정에 저장됩니다.</p>
        <p className="text-m text-text-2">키움 키는 이 브라우저에만 보관할 예정이어서, 지금은 연결 단계가 없습니다.</p>
        <div className="mt-auto flex justify-end pt-2">
          <button type="button" className="btn-primary h-9 px-4" onClick={hide}>닫기</button>
        </div>
      </div>
    </div>
  );
}
