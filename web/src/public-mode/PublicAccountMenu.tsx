import { useState } from "react";
import { ApiRequestError } from "../api/http";
import { DELETE_PHRASE, deleteFailureText, formatSignedInAt } from "../features/account/accountMenu";
import { PROVIDER_NAME } from "../features/account/provider";
import { useReturnFocus } from "../features/account/useReturnFocus";
import { useCommand } from "../features/system-settings/useCommand";
import { Field } from "../features/ui/Field";
import { useAccountStore } from "../stores/account";
import { deletePublicAccount, logoutPublic } from "./accountActions";

export const DELETE_WARNING = "계정 서버에 있는 이 계정과 올려 둔 셋업을 지웁니다.";

export function PublicAccountMenu() {
  const status = useAccountStore((s) => s.status);
  const command = useCommand();
  const [deleting, setDeleting] = useState(false);
  const [phrase, setPhrase] = useState("");
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const deleteButton = useReturnFocus<HTMLButtonElement>(deleting);

  if (status?.state !== "signed_in") return <p className="text-m text-text-2">로그인 상태를 확인하는 중입니다</p>;

  const remove = async () => {
    setDeleteError(null);
    await command.run(async () => {
      try {
        await deletePublicAccount();
      } catch (e) {
        setDeleteError(deleteFailureText(e instanceof ApiRequestError ? e : null));
        throw e;
      }
    });
  };

  return (
    <div className="flex flex-col gap-4">
      <dl className="grid grid-cols-[minmax(0,10rem)_minmax(0,1fr)] gap-x-4 gap-y-3 text-m max-md:grid-cols-1 max-md:gap-y-1">
        <dt className="text-text-2">로그인 방식</dt>
        <dd className="max-md:mb-2">{PROVIDER_NAME[status.provider]}</dd>
        <dt className="text-text-2">로그인 시각</dt>
        <dd className="max-md:mb-2">{formatSignedInAt(status.signedInAt)}</dd>
      </dl>
      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn" disabled={command.busy} onClick={() => void command.run(logoutPublic)}>로그아웃</button>
        {!deleting && <button ref={deleteButton} type="button" className="btn text-danger" onClick={() => setDeleting(true)}>계정 삭제</button>}
      </div>
      {deleting && (
        <section aria-label="계정 삭제" className="flex flex-col gap-3 rounded-m border border-line bg-surface p-4">
          <p className="text-m">{DELETE_WARNING}</p>
          <Field label={`확인하려면 “${DELETE_PHRASE}”을 입력하세요`} autoFocus value={phrase} autoComplete="off" spellCheck={false} onChange={(e) => setPhrase(e.target.value)} />
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn" disabled={command.busy} onClick={() => { setDeleting(false); setPhrase(""); setDeleteError(null); }}>취소</button>
            <button type="button" className="btn-danger" disabled={phrase.trim() !== DELETE_PHRASE || command.busy} onClick={() => void remove()}>
              계정 삭제 실행
            </button>
          </div>
          {deleteError && <p role="alert" className="text-m text-danger">{deleteError}</p>}
        </section>
      )}
      {command.error && !deleting && <p role="alert" className="text-m text-danger">{command.error}</p>}
    </div>
  );
}
