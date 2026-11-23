import { useEffect, useReducer, useState } from "react";
import type { VaultView } from "../../engine/vault";
import { KeyFields } from "../../features/system-settings/KiwoomKeyFields";
import { canAdd, emptyEntry, keyEntryReducer } from "../../features/system-settings/kiwoomKeys";
import { useCommand } from "../../features/system-settings/useCommand";
import { atLimit, defaultAlias } from "./keyEntry";
import { useKeyVault } from "./vaultStore";

export function AddKey({ view }: { view: VaultView }) {
  const apply = useKeyVault((s) => s.apply);
  const command = useCommand();
  const [open, setOpen] = useState(false);
  const [entry, dispatch] = useReducer(keyEntryReducer, defaultAlias(view), emptyEntry);
  const empty = view.keys.length === 0;

  useEffect(() => {
    if (empty) dispatch({ type: "reset", alias: defaultAlias(view) });
  }, [empty, view.keys.length]);

  if (view.locked) return null;
  if (atLimit(view)) return <p className="text-m text-text-2">키는 {view.limit}개까지입니다</p>;
  if (!open && !empty) {
    return <button type="button" className="tb-btn h-9 self-start px-3" onClick={() => { dispatch({ type: "reset", alias: defaultAlias(view) }); setOpen(true); }}>＋ 키 더하기</button>;
  }

  const save = async () => {
    const input = { alias: entry.alias, broker: "kiwoom", appKey: entry.appKey, appSecret: entry.appSecret };
    if (!(await command.run(() => apply((vault) => vault.addKey(input))))) return;
    dispatch({ type: "reset", alias: "" });
    setOpen(false);
  };

  return (
    <form aria-label="키 더하기" className="flex flex-col gap-2" autoComplete="off" onSubmit={(e) => { e.preventDefault(); if (canAdd(entry) && !command.busy) void save(); }}>
      <KeyFields entry={entry} dispatch={dispatch} disabled={command.busy} />
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="tb-btn h-9 px-3" onClick={() => dispatch({ type: "toggleReveal" })}>{entry.reveal ? "입력 가리기" : "입력 보기"}</button>
        <button type="submit" className="btn-primary h-9 px-4 disabled:cursor-not-allowed disabled:opacity-50" disabled={command.busy || !canAdd(entry)}>저장</button>
        {!empty && <button type="button" className="tb-btn h-9 px-3" onClick={() => setOpen(false)}>취소</button>}
      </div>
      <p className="text-s text-text-3">저장만 합니다. 키움에 연결하지 않고, 서버로 보내지 않습니다</p>
      {command.error && <p role="alert" className="text-m text-danger">{command.error}</p>}
    </form>
  );
}
