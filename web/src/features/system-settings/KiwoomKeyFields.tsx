import type { Dispatch } from "react";
import { FIELD } from "./KiwoomKeyForm";
import type { KeyEntry, KeyEntryEvent } from "./kiwoomKeys";

const ROW = "flex items-center gap-2 text-m max-md:flex-col max-md:items-stretch max-md:gap-1";

export function KeyFields({ entry, dispatch, disabled, keyHint }: { entry: KeyEntry; dispatch: Dispatch<KeyEntryEvent>; disabled: boolean; keyHint?: string }) {
  const type = entry.reveal ? "text" : "password";
  return (
    <>
      <label className={ROW}>
        <span className="w-16 flex-none text-text-2">별칭</span>
        <input className={FIELD} type="text" name="kiwoom-key-alias" autoComplete="off" maxLength={20} disabled={disabled} value={entry.alias} onChange={(e) => dispatch({ type: "alias", value: e.target.value })} />
      </label>
      <label className={ROW}>
        <span className="w-16 flex-none text-text-2">앱키</span>
        <input className={FIELD} type={type} name="kiwoom-app-key" autoComplete="off" spellCheck={false} placeholder={keyHint} disabled={disabled} value={entry.appKey} onChange={(e) => dispatch({ type: "appKey", value: e.target.value })} />
      </label>
      <label className={ROW}>
        <span className="w-16 flex-none text-text-2">시크릿</span>
        <input className={FIELD} type={type} name="kiwoom-app-secret" autoComplete="off" spellCheck={false} placeholder={keyHint} disabled={disabled} value={entry.appSecret} onChange={(e) => dispatch({ type: "appSecret", value: e.target.value })} />
      </label>
    </>
  );
}
