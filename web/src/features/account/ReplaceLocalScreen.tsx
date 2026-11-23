import { useState } from "react";
import { logout, replaceLocalSetup } from "../../api/account";
import type { AccountStatus } from "../../api/generated/AccountStatus";
import { useCommand } from "../system-settings/useCommand";
import { Field } from "../ui/Field";
import { REPLACE_PHRASE } from "./accountMenu";
import { PROVIDER_NAME, shortAccountId } from "./provider";
import { useReturnFocus } from "./useReturnFocus";

export function ReplaceLocalScreen({ status }: { status: Extract<AccountStatus, { state: "owner_mismatch" }> }) {
  const [asking, setAsking] = useState(false);
  const [phrase, setPhrase] = useState("");
  const command = useCommand();
  const askButton = useReturnFocus<HTMLButtonElement>(asking);
  const cancel = () => {
    setAsking(false);
    setPhrase("");
  };
  return (
    <main aria-label="계정 바꾸기 확인" className="grid min-h-dvh place-items-center bg-bg p-4">
      <div className="flex w-full max-w-140 flex-col gap-4 rounded-l border border-line bg-surface p-5 md:p-6">
        <h1 className="text-h font-semibold">이 PC의 셋업은 다른 계정 것입니다</h1>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-m">
          <dt className="text-text-2">이 PC 셋업의 계정</dt>
          <dd>번호 <span className="font-mono">{shortAccountId(status.localOwner)}</span></dd>
          <dt className="text-text-2">지금 로그인한 계정</dt>
          <dd>{PROVIDER_NAME[status.provider]} · 번호 <span className="font-mono">{shortAccountId(status.accountId)}</span></dd>
        </dl>
        <div className="grid grid-cols-2 gap-3 max-md:grid-cols-1">
          <section aria-label="이전 계정으로 다시 로그인" className="flex flex-col gap-3 rounded-m border border-line bg-raised p-4">
            <h2 className="text-m font-semibold">이전 계정으로 다시 로그인</h2>
            <p className="flex-1 text-s text-text-2">지금 계정에서 로그아웃하고 이 PC의 셋업을 쓰던 계정으로 다시 로그인합니다. 아무것도 지워지지 않습니다.</p>
            <button type="button" className="btn-primary self-start" disabled={command.busy} onClick={() => void command.run(logout)}>이전 계정으로 다시 로그인</button>
          </section>
          <section aria-label="이 PC를 지금 계정으로 바꾸기" className="flex flex-col gap-3 rounded-m border border-line bg-raised p-4">
            <h2 className="text-m font-semibold">이 PC를 지금 계정으로 바꾸기</h2>
            <p className="flex-1 text-s text-text-2">이 PC의 관심종목, 레이아웃, 드로잉 같은 셋업을 지우고 지금 계정의 셋업으로 바꿉니다. 되돌릴 수 없습니다.</p>
            {!asking && <button ref={askButton} type="button" className="btn text-danger self-start" onClick={() => setAsking(true)}>이 PC를 지금 계정으로 바꾸기</button>}
          </section>
        </div>
        {asking && (
          <section aria-label="지우고 바꾸기 확인" className="flex flex-col gap-3 rounded-m border border-[var(--line-strong)] bg-raised p-4">
            <p className="text-m font-semibold">이 PC의 관심종목, 레이아웃, 드로잉 같은 셋업을 지우고 지금 계정으로 바꿉니다. 되돌릴 수 없습니다.</p>
            <Field label={`확인하려면 “${REPLACE_PHRASE}”를 입력하세요`} value={phrase} autoComplete="off" spellCheck={false} onChange={(e) => setPhrase(e.target.value)} />
            <div className="flex flex-wrap justify-end gap-2">
              <button type="button" autoFocus className="btn" disabled={command.busy} onClick={cancel}>취소</button>
              <button type="button" className="btn-danger" disabled={phrase.trim() !== REPLACE_PHRASE || command.busy} onClick={() => void command.run(replaceLocalSetup)}>{REPLACE_PHRASE}</button>
            </div>
          </section>
        )}
        {command.error && <p role="alert" className="text-m text-danger">{command.error}</p>}
      </div>
    </main>
  );
}
