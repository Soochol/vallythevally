import { useQueryClient } from "@tanstack/react-query";
import { type RefObject, useId, useState } from "react";
import type { MarginPolicy } from "../../api/generated/MarginPolicy";
import type { TradingOrderable } from "../../api/generated/TradingOrderable";
import { Popover } from "../overlay/Popover";
import { type FundsCard, fundsView, MARGIN_CONFIRM_TEXT, MARGIN_LOCKED_TEXT, marginLocked } from "./funds";
import { listAnchorRect, listWidthIn, listWindowOf } from "./listPopover";
import { putMarginPolicy } from "./orderApi";
import { ORDERABLE_QUERY_KEY } from "./useOrderData";

interface Props {
  readonly account: string | null;
  readonly orderable: TradingOrderable;
  readonly opener: RefObject<HTMLElement | null>;
  readonly onClose: () => void;
}

interface CardProps {
  readonly card: FundsCard;
  readonly pressed: boolean;
  readonly disabled: boolean;
  readonly title?: string;
  readonly noteId?: string;
  readonly onSelect: () => void;
}

function FundsLimitCard({ card, pressed, disabled, title, noteId, onSelect }: CardProps) {
  const id = useId();
  const nameId = `${id}-name`;
  const tagId = `${id}-tag`;
  const amountId = `${id}-amount`;
  const quantityId = `${id}-quantity`;
  const describedBy = [tagId, amountId, card.quantity !== null ? quantityId : null, noteId ?? null]
    .filter((part): part is string => part !== null)
    .join(" ");

  return (
    <button
      type="button"
      className="od-funds-card"
      data-testid={`funds-${card.key}`}
      aria-pressed={pressed}
      aria-labelledby={nameId}
      aria-describedby={describedBy}
      disabled={disabled}
      title={title}
      onClick={onSelect}
    >
      <span className="od-funds-card-head">
        <i className="od-funds-card-dot" aria-hidden="true" />
        <span id={nameId}>{card.name}</span>
        <small id={tagId} className="od-funds-card-tag">{card.tag}</small>
      </span>
      <b id={amountId} className="od-funds-amount" data-testid={`funds-${card.key}-amount`}>{card.amount}</b>
      {card.quantity !== null && (
        <span id={quantityId} className="od-funds-qty" data-testid={`funds-${card.key}-quantity`} data-zero={card.zero ? "" : undefined}>
          {card.quantity}
        </span>
      )}
    </button>
  );
}

export function FundsPopover({ account, orderable, opener, onClose }: Props) {
  const client = useQueryClient();
  const lockedId = useId();
  const [confirming, setConfirming] = useState(false);
  const [requested, setRequested] = useState<MarginPolicy | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const policy = requested ?? orderable.policy;
  const locked = marginLocked(orderable.accountRate);
  const busy = requested !== null;
  const window = listWindowOf(opener.current);
  const view = fundsView(orderable);
  const [cashCard, marginCard] = view.cards;

  const change = async (next: MarginPolicy) => {
    setConfirming(false);
    setFailure(null);
    setRequested(next);
    try {
      await putMarginPolicy(next, account);
      await client.invalidateQueries({ queryKey: ORDERABLE_QUERY_KEY });
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "미수 정책을 바꾸지 못했습니다");
    } finally {
      setRequested(null);
    }
  };

  return (
    <Popover solid anchor={opener} anchorRect={() => listAnchorRect(opener.current)} style={window && { width: listWidthIn(window) }} releasesClick={(target) => opener.current?.contains(target) === true} onClose={onClose} role="dialog" aria-label="자금" className="od-list-pop od-funds" data-testid="funds-panel">
      <div className="od-funds-head" data-testid="funds-title">
        <h4>매수 가능 자금</h4>
        <span>{view.basis}</span>
      </div>
      <div className="od-funds-cards" role="group" aria-label="미수 정책" data-testid="margin-toggle" data-policy={policy} data-scale={view.amountScale}>
        <FundsLimitCard
          card={cashCard}
          pressed={policy === "cash_only"}
          disabled={busy}
          onSelect={() => void change("cash_only")}
        />
        <FundsLimitCard
          card={marginCard}
          pressed={policy === "allow_margin"}
          disabled={busy || locked || policy === "allow_margin"}
          title={locked ? MARGIN_LOCKED_TEXT : undefined}
          noteId={locked ? lockedId : undefined}
          onSelect={() => setConfirming(true)}
        />
      </div>
      <dl className="od-funds-facts">
        <div data-testid="funds-deposit">
          <dt>예수금</dt>
          <dd>{view.deposit}</dd>
        </div>
        {view.unpaid !== null && (
          <div data-testid="funds-unpaid" data-danger="">
            <dt>미수금</dt>
            <dd>{view.unpaid}</dd>
          </div>
        )}
        {view.rates !== null && (
          <div data-testid="funds-rates">
            <dt>증거금률</dt>
            <dd>적용 <b>{view.rates.applied}</b><em>{view.rates.detail}</em></dd>
          </div>
        )}
      </dl>
      {locked && <p id={lockedId} className="od-funds-note" data-testid="margin-locked">{MARGIN_LOCKED_TEXT}</p>}
      {confirming && (
        <div className="od-funds-confirm" role="alertdialog" aria-label="미수 허용 확인" data-testid="margin-confirm">
          <p>{MARGIN_CONFIRM_TEXT}</p>
          <div className="od-funds-confirm-actions">
            <button type="button" className="btn btn-sm" onClick={() => setConfirming(false)}>그대로 두기</button>
            <button type="button" className="btn-primary btn-sm" onClick={() => void change("allow_margin")}>허용으로 바꾸기</button>
          </div>
        </div>
      )}
      {failure !== null && <p className="od-funds-note" data-tone="error" role="alert" data-testid="margin-failure">{failure}</p>}
    </Popover>
  );
}
