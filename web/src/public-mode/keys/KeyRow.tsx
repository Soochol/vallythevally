import { useReducer, useState } from "react";
import type { KeyView } from "../../engine/vault";
import { confirmAction } from "../../features/overlay/Confirm";
import { KeyFields } from "../../features/system-settings/KiwoomKeyFields";
import { emptyEntry, keyEntryReducer } from "../../features/system-settings/kiwoomKeys";
import { useCommand } from "../../features/system-settings/useCommand";
import { keyEdit } from "./keyEntry";
import { useKeyVault } from "./vaultStore";

export function KeyRow({ entry, locked, nextMarket }: { entry: KeyView; locked: boolean; nextMarket: KeyView | undefined }) {
  const apply = useKeyVault((s) => s.apply);
  const command = useCommand();
  const [editing, setEditing] = useState(false);
  const [form, dispatch] = useReducer(keyEntryReducer, entry.alias, emptyEntry);
  const edit = keyEdit(form, entry);

  const save = async () => {
    if (!edit) return;
    if (!(await command.run(() => apply((vault) => vault.updateKey(entry.keyId, edit))))) return;
    setEditing(false);
    dispatch({ type: "reset", alias: edit.alias ?? entry.alias });
  };
  const remove = async () => {
    const text = entry.market
      ? nextMarket ? `‘${entry.alias}’는 시세 키입니다. 지우면 ‘${nextMarket.alias}’가 시세 키가 됩니다` : `‘${entry.alias}’ 키를 지웁니다`
      : `‘${entry.alias}’ 키를 지웁니다`;
    if (!(await confirmAction(text, { action: "키 지우기", danger: true }))) return;
    await command.run(() => apply((vault) => vault.removeKey(entry.keyId)));
  };

  return (
    <li className="flex flex-col gap-2 border-b border-line py-2 last:border-b-0" data-testid="browser-key-row" data-key-id={entry.keyId}>
      <div className="flex min-h-9 flex-wrap items-center gap-2">
        <span className="min-w-0 truncate text-m font-semibold text-text">{entry.alias}</span>
        {entry.market && <span className="flex-none rounded-s bg-accent-soft px-2 py-0.5 text-xs text-accent">시세</span>}
        <span className="min-w-0 break-all font-mono text-s text-text-2">{entry.maskedAppKey}</span>
        <span className="flex-1" />
        {!editing && (
          <>
            <button type="button" className="tb-btn h-9 px-3 disabled:opacity-50" disabled={locked || command.busy} onClick={() => setEditing(true)}>바꾸기</button>
            <button type="button" className="tb-btn h-9 px-3 text-danger disabled:opacity-50" disabled={command.busy} onClick={() => void remove()}>지우기</button>
          </>
        )}
      </div>
      {editing && (
        <form aria-label="키 바꾸기" className="flex flex-col gap-2" autoComplete="off" onSubmit={(e) => { e.preventDefault(); if (edit && !command.busy) void save(); }}>
          <KeyFields entry={form} dispatch={dispatch} disabled={command.busy} keyHint="비우면 그대로" />
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className="tb-btn h-9 px-3" onClick={() => dispatch({ type: "toggleReveal" })}>{form.reveal ? "입력 가리기" : "입력 보기"}</button>
            <button type="submit" className="btn-primary h-9 px-4 disabled:cursor-not-allowed disabled:opacity-50" disabled={command.busy || !edit}>저장</button>
            <button type="button" className="tb-btn h-9 px-3" onClick={() => { setEditing(false); dispatch({ type: "reset", alias: entry.alias }); }}>취소</button>
          </div>
        </form>
      )}
      {command.error && <p role="alert" className="text-m text-danger">{command.error}</p>}
    </li>
  );
}
