import { useState } from "react";
import { deleteAccount, logout, syncNow } from "../../api/account";
import { ApiRequestError } from "../../api/http";
import { useAccountStore } from "../../stores/account";
import { useSelectionStore } from "../../stores/selection";
import { useWizardStore } from "../setup-wizard/wizardOpen";
import { syncErrorText } from "../status/syncView";
import { useCommand } from "../system-settings/useCommand";
import { DELETE_PHRASE, deleteFailureText, formatSignedInAt, lastSyncText } from "./accountMenu";
import { PROVIDER_NAME, shortAccountId } from "./provider";
import { useReturnFocus } from "./useReturnFocus";

export function AccountMenuContent() {
  const status = useAccountStore((s) => s.status);
  const command = useCommand();
  const [deleting, setDeleting] = useState(false);
  const [phrase, setPhrase] = useState("");
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const deleteButton = useReturnFocus<HTMLButtonElement>(deleting);

  if (!status) return <p className="text-m text-text-2">계정 상태를 불러오는 중입니다</p>;
  if (status.state === "local_only") return <p className="text-m text-text-2">계정 서버를 쓰지 않습니다. 셋업은 이 PC에만 있습니다.</p>;
  if (status.state !== "signed_in") return null;

  const remove = async () => {
    setDeleteError(null);
    const done = await command.run(async () => {
      try {
        await deleteAccount();
      } catch (e) {
        setDeleteError(deleteFailureText(e instanceof ApiRequestError ? e : null));
        throw e;
      }
    });
    if (done) setDeleting(false);
  };

  return (
    <div className="flex flex-col gap-4">
      <dl className="grid grid-cols-[minmax(0,10rem)_minmax(0,1fr)] gap-x-4 gap-y-3 text-m max-md:grid-cols-1 max-md:gap-y-1">
        <dt className="text-text-2">로그인 방식</dt>
        <dd className="max-md:mb-2">{PROVIDER_NAME[status.provider]}</dd>
        <dt className="text-text-2">계정 번호</dt>
        <dd className="font-mono max-md:mb-2">{shortAccountId(status.accountId)}</dd>
        <dt className="text-text-2">로그인 시각</dt>
        <dd className="max-md:mb-2">{formatSignedInAt(status.signedInAt)}</dd>
      </dl>
      {status.sync.state === "running" && (
        <section aria-label="동기화" className="flex flex-col gap-3 rounded-m border border-line bg-surface p-4">
          <h3 className="text-m font-semibold">동기화</h3>
          <dl className="grid grid-cols-[minmax(0,10rem)_minmax(0,1fr)] gap-x-4 gap-y-3 text-m max-md:grid-cols-1 max-md:gap-y-1">
            <dt className="text-text-2">마지막 성공</dt>
            <dd className="max-md:mb-2">{lastSyncText(status.sync.lastSuccessAt)}</dd>
            <dt className="text-text-2">올리지 못한 변경</dt>
            <dd className="max-md:mb-2">{status.sync.pendingDocuments}개</dd>
            <dt className="text-text-2">거절된 문서</dt>
            <dd className="max-md:mb-2">{status.sync.refusedDocuments}개</dd>
            <dt className="text-text-2">마지막 오류</dt>
            <dd className="max-md:mb-2">{status.sync.lastError === null ? "없음" : syncErrorText(status.sync.lastError)}</dd>
          </dl>
          <button type="button" className="tb-btn h-9 self-start border border-line px-3" disabled={command.busy} onClick={() => void command.run(syncNow)}>지금 동기화</button>
        </section>
      )}
      <div className="flex flex-wrap gap-2">
        <button type="button" className="tb-btn h-9 border border-line px-3" onClick={() => { useSelectionStore.getState().closeDialog(); useWizardStore.getState().show(); }}>셋업 마법사 다시 열기</button>
        <button type="button" className="tb-btn h-9 border border-line px-3" disabled={command.busy} onClick={() => void command.run(logout)}>로그아웃</button>
        {!deleting && <button ref={deleteButton} type="button" className="tb-btn h-9 border border-line px-3 text-danger" onClick={() => setDeleting(true)}>계정 삭제</button>}
      </div>
      {deleting && (
        <section aria-label="계정 삭제" className="flex flex-col gap-3 rounded-m border border-line bg-surface p-4">
          <p className="text-m">계정 서버에 있는 이 계정과 올려 둔 셋업을 지웁니다. 이 PC의 셋업은 남습니다.</p>
          <label className="flex flex-col gap-1 text-m">
            <span className="text-text-2">확인하려면 “{DELETE_PHRASE}”을 입력하세요</span>
            <input autoFocus className="ui-field" value={phrase} autoComplete="off" spellCheck={false} onChange={(e) => setPhrase(e.target.value)} />
          </label>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="tb-btn h-9 bg-[color-mix(in_srgb,var(--danger)_16%,transparent)] px-3 font-semibold text-danger disabled:opacity-50" disabled={phrase.trim() !== DELETE_PHRASE || command.busy} onClick={() => void remove()}>
              계정 삭제 실행
            </button>
            <button type="button" className="tb-btn h-9 px-3" disabled={command.busy} onClick={() => { setDeleting(false); setPhrase(""); setDeleteError(null); }}>취소</button>
          </div>
          {deleteError && <p role="alert" className="text-m text-danger">{deleteError}</p>}
        </section>
      )}
      {command.error && !deleting && <p role="alert" className="text-m text-danger">{command.error}</p>}
    </div>
  );
}
