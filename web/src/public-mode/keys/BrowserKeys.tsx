import { useEffect } from "react";
import { confirmAction } from "../../features/overlay/Confirm";
import { useCommand } from "../../features/system-settings/useCommand";
import { AddKey } from "./AddKey";
import { KeyRow } from "./KeyRow";
import { LockPassword, UnlockForm } from "./LockPassword";
import { MarketPicker } from "./MarketPicker";
import { useKeyVault, wipeBrowserKeys } from "./vaultStore";

export function BrowserKeys() {
  const view = useKeyVault((s) => s.view);
  const loadFailure = useKeyVault((s) => s.loadFailure);
  const load = useKeyVault((s) => s.load);
  const wipe = useCommand();

  useEffect(() => {
    void load();
  }, [load]);

  const wipeAll = async () => {
    if (!(await confirmAction("이 브라우저에 저장한 키를 모두 지웁니다. 되돌릴 수 없습니다", { action: "모든 키 지우기", danger: true }))) return;
    await wipe.run(wipeBrowserKeys);
  };

  return (
    <section aria-label="키움 키" data-testid="browser-keys" className="flex flex-col gap-4">
      <div className="flex flex-col gap-1 rounded-m border border-line bg-surface p-4">
        <p className="text-m font-semibold text-text">이번 단계는 키를 저장만 합니다. 키를 쓰는 기능은 다음 단계에 나옵니다</p>
        <p className="text-s text-text-3">이 브라우저에 암호화해 저장합니다. 저장값이 평문으로 남지 않습니다. 키는 서버로 보내지 않습니다.</p>
        <p className="text-s text-text-3">공개 주소가 바뀌면 키를 다시 넣어야 합니다.</p>
      </div>
      {loadFailure && <p role="alert" className="text-m text-danger">{loadFailure}</p>}
      {view && (
        <>
          {view.locked && <UnlockForm />}
          <div className="flex flex-col gap-3 rounded-m border border-line bg-surface p-4">
            <h3 className="text-m font-semibold">키</h3>
            {view.keys.length > 0 && (
              <ul aria-label="저장한 키" className="flex flex-col">
                {view.keys.map((entry) => <KeyRow key={entry.keyId} entry={entry} locked={view.locked} nextMarket={view.keys.find((key) => key.keyId !== entry.keyId)} />)}
              </ul>
            )}
            <MarketPicker view={view} />
            <AddKey view={view} />
            <p className="text-s text-text-3">한국투자증권은 공개 모드에서는 아직 지원하지 않습니다</p>
          </div>
          <LockPassword view={view} />
          <div className="flex flex-col items-start gap-2">
            <button type="button" className="tb-btn h-9 px-3 text-danger disabled:opacity-50" disabled={wipe.busy} onClick={() => void wipeAll()}>모든 키 지우기</button>
            {wipe.error && <p role="alert" className="text-m text-danger">{wipe.error}</p>}
          </div>
        </>
      )}
    </section>
  );
}
