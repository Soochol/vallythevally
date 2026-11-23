import { useState } from "react";
import { deleteAccount, logout, syncNow } from "../../api/account";
import { ApiRequestError } from "../../api/http";
import type { SyncStatus } from "../../api/generated/SyncStatus";
import { useAccountStore } from "../../stores/account";
import { useSelectionStore } from "../../stores/selection";
import { useWizardStore } from "../setup-wizard/wizardOpen";
import { useCommand } from "../system-settings/useCommand";
import { Badge } from "../ui/Badge";
import { Field } from "../ui/Field";
import { Notice } from "../ui/Notice";
import { DELETE_PHRASE, deleteFailureText, formatSignedInAt, lastSyncText, syncBand } from "./accountMenu";
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
      {status.sync.state === "running" && <SyncCard sync={status.sync} busy={command.busy} onSync={() => void command.run(syncNow)} />}
      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn" onClick={() => { useSelectionStore.getState().closeDialog(); useWizardStore.getState().show(); }}>셋업 마법사 다시 열기</button>
        <button type="button" className="btn" disabled={command.busy} onClick={() => void command.run(logout)}>로그아웃</button>
        {!deleting && <button ref={deleteButton} type="button" className="btn text-danger" onClick={() => setDeleting(true)}>계정 삭제</button>}
      </div>
      {deleting && (
        <section aria-label="계정 삭제" className="flex flex-col gap-3 rounded-m border border-line bg-surface p-4">
          <p className="text-m">계정 서버에 있는 이 계정과 올려 둔 셋업을 지웁니다. 이 PC의 셋업은 남습니다.</p>
          <Field label={`확인하려면 “${DELETE_PHRASE}”을 입력하세요`} autoFocus value={phrase} autoComplete="off" spellCheck={false} onChange={(e) => setPhrase(e.target.value)} />
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn-danger" disabled={phrase.trim() !== DELETE_PHRASE || command.busy} onClick={() => void remove()}>계정 삭제 실행</button>
            <button type="button" className="btn" disabled={command.busy} onClick={() => { setDeleting(false); setPhrase(""); setDeleteError(null); }}>취소</button>
          </div>
          {deleteError && <p role="alert" className="text-m text-danger">{deleteError}</p>}
        </section>
      )}
      {command.error && !deleting && <p role="alert" className="text-m text-danger">{command.error}</p>}
    </div>
  );
}

function SyncCard({ sync, busy, onSync }: { sync: Extract<SyncStatus, { state: "running" }>; busy: boolean; onSync(): void }) {
  const band = syncBand(sync);
  return (
    <section aria-label="동기화" className="flex flex-col gap-3 rounded-m border border-line bg-surface p-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-m font-semibold">동기화</h3>
        {band.kind === "synced" && <Badge tone="success">동기화됨</Badge>}
        {band.kind === "uploading" && <Badge>올리는 중</Badge>}
      </div>
      {band.kind === "error" && <Notice tone="danger" action={{ label: "지금 동기화", onClick: onSync }}>{band.text}</Notice>}
      <dl className="grid grid-cols-[minmax(0,10rem)_minmax(0,1fr)] gap-x-4 gap-y-3 text-m max-md:grid-cols-1 max-md:gap-y-1">
        <dt className="text-text-2">마지막 성공</dt>
        <dd className="max-md:mb-2">{lastSyncText(sync.lastSuccessAt)}</dd>
        <dt className="text-text-2">올리지 못한 변경</dt>
        <dd className="max-md:mb-2">{sync.pendingDocuments}개</dd>
        <dt className="text-text-2">거절된 문서</dt>
        <dd className="max-md:mb-2">{sync.refusedDocuments}개</dd>
      </dl>
      {band.kind !== "error" && <button type="button" className="btn self-start" disabled={busy} onClick={onSync}>지금 동기화</button>}
    </section>
  );
}
