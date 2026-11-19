import { useQueryClient } from "@tanstack/react-query";
import { type RefObject, useState } from "react";
import type { MarginPolicy } from "../../api/generated/MarginPolicy";
import type { TradingOrderable } from "../../api/generated/TradingOrderable";
import { Popover } from "../overlay/Popover";
import { fundsRows, fundsTitle, MARGIN_CONFIRM_TEXT, MARGIN_LOCKED_TEXT, marginLocked } from "./funds";
import { listAnchorRect, listWidthIn, listWindowOf } from "./listPopover";
import { putMarginPolicy } from "./orderApi";
import { ORDERABLE_QUERY_KEY } from "./useOrderData";

interface Props {
  readonly orderable: TradingOrderable;
  readonly opener: RefObject<HTMLElement | null>;
  readonly onClose: () => void;
}

export function FundsPopover({ orderable, opener, onClose }: Props) {
  const client = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const [requested, setRequested] = useState<MarginPolicy | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const policy = requested ?? orderable.policy;
  const locked = marginLocked(orderable.accountRate);
  const busy = requested !== null;
  const window = listWindowOf(opener.current);

  const change = async (next: MarginPolicy) => {
    setConfirming(false);
    setFailure(null);
    setRequested(next);
    try {
      await putMarginPolicy(next);
      await client.invalidateQueries({ queryKey: ORDERABLE_QUERY_KEY });
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "미수 정책을 바꾸지 못했습니다");
    } finally {
      setRequested(null);
    }
  };

  return (
    <Popover anchor={opener} anchorRect={() => listAnchorRect(opener.current)} style={window && { width: listWidthIn(window) }} releasesClick={(target) => opener.current?.contains(target) === true} onClose={onClose} role="dialog" aria-label="자금" className="od-list-pop od-funds" data-testid="funds-panel">
      <h4 className="od-funds-title" data-testid="funds-title">{fundsTitle(orderable)}</h4>
      <ul className="od-rows od-funds-rows" data-testid="funds-rows">
        {fundsRows(orderable).map((row) => (
          <li key={row.key} data-testid={`funds-${row.key}`} data-danger={row.danger ? "" : undefined}>
            <span className="od-name">{row.label}</span>
            <b>{row.value}</b>
          </li>
        ))}
      </ul>
      <div className="od-funds-toggle" role="group" aria-label="미수 정책" data-testid="margin-toggle" data-policy={policy}>
        <button type="button" className="od-funds-option" aria-pressed={policy === "cash_only"} disabled={busy} onClick={() => void change("cash_only")}>미수 막기</button>
        <button type="button" className="od-funds-option" aria-pressed={policy === "allow_margin"} disabled={busy || locked || policy === "allow_margin"} title={locked ? MARGIN_LOCKED_TEXT : undefined} onClick={() => setConfirming(true)}>미수 허용</button>
      </div>
      {locked && <p className="od-funds-note" data-testid="margin-locked">{MARGIN_LOCKED_TEXT}</p>}
      {confirming && (
        <div className="od-funds-confirm" role="alertdialog" aria-label="미수 허용 확인" data-testid="margin-confirm">
          <p>{MARGIN_CONFIRM_TEXT}</p>
          <div className="od-funds-confirm-actions">
            <button type="button" className="od-link" onClick={() => setConfirming(false)}>그대로 두기</button>
            <button type="button" className="od-link" data-danger="" onClick={() => void change("allow_margin")}>허용으로 바꾸기</button>
          </div>
        </div>
      )}
      {failure !== null && <p className="od-funds-note" data-tone="error" role="alert" data-testid="margin-failure">{failure}</p>}
    </Popover>
  );
}
