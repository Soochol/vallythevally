import { type Dispatch, type ReactNode, useState } from "react";
import { ExternalLinkIcon } from "../icons";
import { Field, SecretField } from "../ui/Field";
import { ACCOUNT_NUMBER_HINT, ACCOUNT_SHAPE_HINT, HTS_ID_PLACEHOLDER } from "./kisAccount";
import type { KeyEntry, KeyEntryEvent, KeyFieldErrors, KeyFieldName } from "./kiwoomKeys";

export const PORTAL_URL = "https://openapi.kiwoom.com";

type SecretName = Exclude<KeyFieldName, "alias">;

const TRIMMED_HELP = "앞뒤 공백을 지웠습니다";

function useTrimNotice(entry: KeyEntry, dispatch: Dispatch<KeyEntryEvent>) {
  const [trimmed, setTrimmed] = useState<ReadonlySet<SecretName>>(new Set());
  const change = (field: SecretName) => (value: string) => {
    const before = entry[field];
    if (value !== before && before.trim() === value) setTrimmed((names) => new Set(names).add(field));
    dispatch({ type: field, value });
  };
  return { trimmed, change };
}

export function FormActions({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center justify-end gap-2">{children}</div>;
}

export function CommandAlert({ error, mapped }: { error: string | null; mapped: boolean }) {
  return error === null ? null : <p role="alert" className={mapped ? "sr-only" : "text-m text-danger"}>{error}</p>;
}

export function KeyPortalNote({ broker = "kiwoom" }: { broker?: "kiwoom" | "kis" }) {
  if (broker === "kis") return <p className="text-s text-text-2">앱키·시크릿은 한국투자증권 Open API에서 받고, 계좌번호는 그 앱키를 신청한 계좌를 넣습니다</p>;
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 text-s text-text-2">
      <p className="min-w-0">앱키는 키움 Open API 포털의 앱 관리에서 받습니다</p>
      <a className="btn btn-sm" href={PORTAL_URL} target="_blank" rel="noopener noreferrer">포털 열기 <ExternalLinkIcon size={14} /></a>
    </div>
  );
}

export function KeyFields({ entry, dispatch, disabled, keyHint, errors = {} }: { entry: KeyEntry; dispatch: Dispatch<KeyEntryEvent>; disabled: boolean; keyHint?: string; errors?: KeyFieldErrors }) {
  const { trimmed, change } = useTrimNotice(entry, dispatch);
  return (
    <>
      <Field label="별칭" name="kiwoom-key-alias" autoComplete="off" maxLength={20} disabled={disabled} value={entry.alias} error={errors.alias} onChange={(e) => dispatch({ type: "alias", value: e.target.value })} />
      <SecretField label="앱키" name="kiwoom-app-key" placeholder={keyHint} disabled={disabled} value={entry.appKey} error={errors.appKey} help={trimmed.has("appKey") ? TRIMMED_HELP : undefined} onChange={change("appKey")} />
      <SecretField label="시크릿" name="kiwoom-app-secret" placeholder={keyHint} disabled={disabled} value={entry.appSecret} error={errors.appSecret} help={trimmed.has("appSecret") ? TRIMMED_HELP : undefined} onChange={change("appSecret")} />
    </>
  );
}

export function KisAccountFields({ entry, dispatch, disabled, errors = {} }: { entry: KeyEntry; dispatch: Dispatch<KeyEntryEvent>; disabled: boolean; errors?: KeyFieldErrors }) {
  const { trimmed, change } = useTrimNotice(entry, dispatch);
  return (
    <>
      <SecretField label="계좌번호" name="kis-account-no" maxLength={12} placeholder={ACCOUNT_SHAPE_HINT} disabled={disabled} value={entry.accountNo} error={errors.accountNo} help={trimmed.has("accountNo") ? TRIMMED_HELP : ACCOUNT_NUMBER_HINT} onChange={change("accountNo")} />
      <Field label="HTS ID" name="kis-hts-id" autoComplete="off" spellCheck={false} maxLength={16} placeholder={HTS_ID_PLACEHOLDER} disabled={disabled} value={entry.htsId} onChange={(e) => dispatch({ type: "htsId", value: e.target.value })} />
    </>
  );
}
