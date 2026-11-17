import { useState } from "react";
import { logout, replaceLocalSetup } from "../../api/account";
import type { AccountStatus } from "../../api/generated/AccountStatus";
import { useCommand } from "../system-settings/useCommand";
import { PROVIDER_NAME, shortAccountId } from "./provider";

export function ReplaceLocalScreen({ status }: { status: Extract<AccountStatus, { state: "owner_mismatch" }> }) {
  const [asking, setAsking] = useState(false);
  const command = useCommand();
  return (
    <main aria-label="계정 바꾸기 확인" className="grid min-h-dvh place-items-center bg-bg p-4">
      <div className="flex w-full max-w-[440px] flex-col gap-4 rounded-m border border-line bg-surface p-6">
        <h1 className="text-l font-semibold">이 PC의 셋업은 다른 계정 것입니다</h1>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-m">
          <dt className="text-text-2">이 PC 셋업의 계정</dt>
          <dd className="font-mono">{shortAccountId(status.localOwner)}</dd>
          <dt className="text-text-2">지금 로그인한 계정</dt>
          <dd className="font-mono">{shortAccountId(status.accountId)} · {PROVIDER_NAME[status.provider]}</dd>
        </dl>
        {asking ? (
          <section aria-label="지우고 바꾸기 확인" className="flex flex-col gap-3 rounded-m border border-line bg-raised p-4">
            <p className="text-m">이 PC의 관심종목, 레이아웃, 드로잉 같은 셋업을 지우고 지금 계정으로 바꿉니다. 되돌릴 수 없습니다.</p>
            <div className="flex flex-wrap gap-2">
              <button type="button" className="tb-btn h-9 bg-[color-mix(in_srgb,var(--danger)_16%,transparent)] px-3 font-semibold text-danger" disabled={command.busy} onClick={() => void command.run(replaceLocalSetup)}>
                지우고 바꾸기
              </button>
              <button type="button" className="tb-btn h-9 px-3" disabled={command.busy} onClick={() => setAsking(false)}>취소</button>
            </div>
          </section>
        ) : (
          <div className="flex flex-wrap gap-2">
            <button type="button" className="tb-btn h-9 border border-line px-3" onClick={() => setAsking(true)}>이 PC 셋업 지우고 바꾸기</button>
            <button type="button" className="tb-btn h-9 border border-line px-3" disabled={command.busy} onClick={() => void command.run(logout)}>로그아웃</button>
          </div>
        )}
        {command.error && <p role="alert" className="text-m text-danger">{command.error}</p>}
      </div>
    </main>
  );
}
