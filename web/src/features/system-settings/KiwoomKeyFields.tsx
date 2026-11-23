import type { Dispatch } from "react";
import { FIELD } from "./KiwoomKeyForm";
import { ACCOUNT_NUMBER_HINT, ACCOUNT_SHAPE_HINT, HTS_ID_PLACEHOLDER } from "./kisAccount";
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

export function KisAccountFields({ entry, dispatch, disabled }: { entry: KeyEntry; dispatch: Dispatch<KeyEntryEvent>; disabled: boolean }) {
  return (
    <>
      <label className={ROW}>
        <span className="w-16 flex-none text-text-2">계좌번호</span>
        <input className={FIELD} type={entry.reveal ? "text" : "password"} name="kis-account-no" aria-label="계좌번호" aria-describedby="kis-account-hint" autoComplete="off" spellCheck={false} maxLength={12} placeholder={ACCOUNT_SHAPE_HINT} disabled={disabled} value={entry.accountNo} onChange={(e) => dispatch({ type: "accountNo", value: e.target.value })} />
      </label>
      <p id="kis-account-hint" className="pl-[4.5rem] text-s text-text-3 max-md:pl-0">{ACCOUNT_NUMBER_HINT}</p>
      <label className={ROW}>
        <span className="w-16 flex-none text-text-2">HTS ID</span>
        <input className={FIELD} type="text" name="kis-hts-id" aria-label="HTS ID" autoComplete="off" spellCheck={false} maxLength={16} placeholder={HTS_ID_PLACEHOLDER} disabled={disabled} value={entry.htsId} onChange={(e) => dispatch({ type: "htsId", value: e.target.value })} />
      </label>
    </>
  );
}
