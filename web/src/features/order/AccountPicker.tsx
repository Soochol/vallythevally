import { useQuery } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { Popover } from "../overlay/Popover";
import { openSystemSettings } from "../system-settings/open";
import { fetchAccountNumber } from "./orderApi";
import { accountNumberText, canPick, MANAGE_ACCOUNTS_TEXT, type OrderAccountChoice, optionNote, optionText, selectedKeyAlias } from "./orderAccount";
import { listAnchorRect, listWidthIn, listWindowOf } from "./listPopover";

const BROKER = "키움";
const groupedAccountNumber = (digits: string) => `${digits.slice(0, 4)}-${digits.slice(4, 8)}`;

function useAccountNumberText(choice: OrderAccountChoice, maskAccount: boolean): { text: string; failure: string | undefined } {
  const current = choice.current;
  const ref = current?.ref ?? null;
  const reveal = !maskAccount && current !== null && current.tail !== null && ref !== null;
  const lookup = useQuery({ queryKey: ["trading", "account-number", ref], queryFn: ({ signal }) => fetchAccountNumber(ref, signal), enabled: reveal, gcTime: 0, staleTime: Infinity, retry: false, refetchOnWindowFocus: false });
  const failure = reveal && lookup.isError ? (lookup.error instanceof Error ? lookup.error.message : "계좌번호를 불러오지 못했습니다") : undefined;
  const text = reveal && lookup.data ? `${BROKER} ${groupedAccountNumber(lookup.data.accountNumber)}` : accountNumberText(current?.tail ?? null);
  return { text, failure };
}

interface Props {
  readonly choice: OrderAccountChoice;
  readonly maskAccount: boolean;
  readonly onPick: (accountRef: string) => void;
}

export function AccountLabel({ choice, maskAccount, onPick }: Props) {
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  const number = useAccountNumberText(choice, maskAccount);
  if (!canPick(choice.accounts)) return <span className="od-account-label" data-testid="account-label" title={number.failure}>{number.text}</span>;
  const alias = selectedKeyAlias(choice);
  const window = listWindowOf(opener.current);
  return (
    <>
      <button type="button" ref={opener} className="od-account-label od-account-pick" data-testid="account-label" title={number.failure} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((was) => !was)}>
        <span className="od-account-text">{alias === null ? number.text : `${alias} · ${number.text}`}</span>
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
      </button>
      {open && (
        <Popover anchor={opener} anchorRect={() => listAnchorRect(opener.current)} style={window && { width: listWidthIn(window) }} releasesClick={(target) => opener.current?.contains(target) === true} onClose={() => setOpen(false)} role="dialog" aria-label="주문 계좌" className="od-list-pop od-account-menu" data-testid="account-menu">
          <p className="od-account-menu-head">주문 계좌 · 모든 호가주문창에 적용</p>
          <div role="radiogroup" aria-label="주문 계좌">
            {choice.accounts.map((account) => {
              const note = optionNote(account);
              const checked = account.keyId === choice.current?.keyId;
              const pickable = account.state === "on" && account.accountRef !== null;
              return (
                <button key={account.keyId} type="button" role="radio" aria-checked={checked} aria-disabled={!pickable} className="od-account-option" data-testid="account-option" data-key-id={account.keyId} data-off={pickable ? undefined : ""} onClick={() => { if (!pickable) return; if (account.accountRef !== choice.current?.ref) onPick(account.accountRef!); setOpen(false); }}>
                  <span className="od-account-radio" aria-hidden="true" data-checked={checked ? "" : undefined} />
                  <span className="od-account-option-text">{optionText(account)}</span>
                  {note !== null && <small>{note}</small>}
                </button>
              );
            })}
          </div>
          <button type="button" className="od-link od-account-manage" data-testid="account-manage" onClick={() => { setOpen(false); openSystemSettings("kiwoom"); }}>{MANAGE_ACCOUNTS_TEXT}</button>
        </Popover>
      )}
    </>
  );
}
