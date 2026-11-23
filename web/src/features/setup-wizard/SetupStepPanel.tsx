import { useState } from "react";
import { initialSync } from "../../api/account";
import type { InitialSyncChoice } from "../../api/generated/InitialSyncChoice";
import type { SyncStatus } from "../../api/generated/SyncStatus";
import { useCommand } from "../system-settings/useCommand";
import { choiceText, SUMMARY_TEXT, setupSummary } from "./setupChoice";

const CHOICES: readonly InitialSyncChoice[] = ["upload_local", "take_account"];

export function SetupStepPanel({ sync, chosen, onChosen }: { sync: SyncStatus; chosen: InitialSyncChoice | null; onChosen(choice: InitialSyncChoice): void }) {
  const summary = setupSummary(sync, chosen);
  if (summary.kind === "choose") return <ChoosePanel local={summary.local} account={summary.account} onChosen={onChosen} />;
  return <SyncNote sync={sync} chosen={chosen} />;
}

export function SyncNote({ sync, chosen }: { sync: SyncStatus; chosen: InitialSyncChoice | null }) {
  const summary = setupSummary(sync, chosen);
  if (summary.kind === "choose" || summary.kind === "matched") return null;
  if (summary.kind === "stalled") return <p role="alert" className="text-m text-warning">{summary.text} 다시 시도하려면 시스템 설정의 계정 메뉴에서 지금 동기화를 누르세요.</p>;
  return <p role="status" className="text-m text-text">{SUMMARY_TEXT[summary.kind]}</p>;
}

function ChoosePanel({ local, account, onChosen }: { local: number; account: number; onChosen(choice: InitialSyncChoice): void }) {
  const command = useCommand();
  const [pending, setPending] = useState<InitialSyncChoice | null>(null);
  const confirmText = pending && choiceText(pending, local, account);

  const run = async (choice: InitialSyncChoice) => {
    if (await command.run(async () => { await initialSync(choice); })) onChosen(choice);
  };

  return (
    <section aria-label="기본 셋업 고르기" className="flex flex-col gap-3">
      <p className="text-m text-text">이 PC에도, 계정에도 셋업이 있습니다. 어느 쪽을 쓸지 고르세요. 고르기 전에는 셋업을 올리지도 받지도 않습니다.</p>
      <div className="grid grid-cols-2 gap-3 max-md:grid-cols-1">
        {CHOICES.map((choice) => {
          const text = choiceText(choice, local, account);
          return (
            <button key={choice} type="button" aria-pressed={pending === choice} disabled={command.busy} onClick={() => setPending(choice)} className="flex flex-col items-start gap-2 rounded-m border border-[var(--line-strong)] bg-raised p-3 text-left hover:bg-overlay aria-pressed:border-accent aria-pressed:bg-accent-soft">
              <span className="text-m font-semibold">{text.title}</span>
              <span className="text-s text-text-2">{text.effect}</span>
              <span className="flex flex-col gap-1 text-s">
                <span><span className="font-semibold text-success">남는 것</span> <span className="text-text-2">{text.keeps}</span></span>
                <span><span className="font-semibold text-danger">사라지는 것</span> <span className="text-text-2">{text.loses}</span></span>
              </span>
            </button>
          );
        })}
      </div>
      {pending && confirmText && (
        <div role="group" aria-label="고른 쪽 확인" className="flex flex-col gap-3 rounded-m border border-[var(--line-strong)] p-3">
          <p className="text-m font-semibold text-text">{confirmText.effect} {confirmText.warning}</p>
          <div className="flex flex-wrap justify-end gap-2">
            <button type="button" className="btn" disabled={command.busy} onClick={() => setPending(null)}>다시 고르기</button>
            <button type="button" className="btn-danger" disabled={command.busy} onClick={() => void run(pending)}>{confirmText.confirm}</button>
          </div>
        </div>
      )}
      {command.error && <p role="alert" className="text-m text-danger">{command.error}</p>}
    </section>
  );
}
