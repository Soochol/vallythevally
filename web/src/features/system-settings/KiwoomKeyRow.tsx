import { useQueryClient } from "@tanstack/react-query";
import { useReducer, useState } from "react";
import type { KiwoomKey } from "../../api/generated/KiwoomKey";
import type { OrdersAccount } from "../../api/generated/OrdersAccount";
import type { KiwoomKeyList } from "../../api/generated/KiwoomKeyList";
import { connectKiwoomKey, disconnectKiwoomKey, loadKiwoomLink, removeKiwoomKey, renameKiwoomKey, replaceKiwoomKey, storeKiwoomKeys } from "../../api/system";
import { confirmAction } from "../overlay/Confirm";
import { KeyFields } from "./KiwoomKeyFields";
import { ReadOnlyRow, SaveNote } from "./KiwoomKeyForm";
import { KiwoomRowOrders } from "./KiwoomRowOrders";
import { Confirm } from "./KiwoomStatusCard";
import { emptyEntry, editRequest, keyEntryReducer, removeText, shortReason } from "./kiwoomKeys";
import { keySaveNote, maskedAppKey, NO_CONFIRMATIONS } from "./kiwoomPanel";
import { linkDotTone } from "./linkDot";
import { accountNumberOf, orderInUse, orderMarkOf } from "./orderUse";
import { useCommand } from "./useCommand";
import { useConfirmations } from "./useConfirmations";

interface Props {
  entry: KiwoomKey;
  order: OrdersAccount | undefined;
  keys: readonly KiwoomKey[];
  mock: boolean;
  expanded: boolean;
  now: number;
  onToggle(): void;
  onOpenIpHelp(): void;
}

const orderMarkStyle = (tone: "on" | "off" | "warn") => ({ color: tone === "on" ? "var(--success)" : tone === "warn" ? "var(--warning)" : "var(--text-3)", background: "var(--raised)" });

export function KiwoomKeyRow({ entry, order, keys, mock, expanded, now, onToggle, onOpenIpHelp }: Props) {
  const reason = shortReason(entry.link, now);
  return (
    <li className="flex flex-col border-b border-line last:border-b-0">
      <button type="button" aria-expanded={expanded} className="flex min-h-11 w-full items-center gap-2 px-1 py-2 text-left max-md:flex-wrap" onClick={onToggle}>
        <span aria-hidden="true" className="conn-dot flex-none" data-tone={linkDotTone(entry.link)} />
        <span className="min-w-0 truncate text-m font-semibold text-text">{entry.alias}</span>
        {entry.market && <span className="flex-none rounded-s bg-accent-soft px-2 py-0.5 text-xs text-accent">시세</span>}
        {entry.source === "env" && <span className="flex-none rounded-s bg-raised px-2 py-0.5 text-xs text-text-2">{mock ? "모의투자" : ".env"}</span>}
        {order && <span className="flex-none text-s text-text-2" data-testid="key-account">{accountNumberOf(order.accountTail)}</span>}
        {order && <span className="flex-none rounded-s px-2 py-0.5 text-xs" data-testid="key-order-mark" data-tone={orderMarkOf(order.state).tone} style={orderMarkStyle(orderMarkOf(order.state).tone)}>{orderMarkOf(order.state).text}</span>}
        <span className="flex-1" />
        {reason && <span className="min-w-0 truncate text-s text-warning">{reason}</span>}
        <span aria-hidden="true" className="flex-none text-text-3">{expanded ? "접기" : "펼치기"}</span>
      </button>
      {expanded && <KeyDetails entry={entry} order={order} keys={keys} now={now} onOpenIpHelp={onOpenIpHelp} />}
    </li>
  );
}

function KeyDetails({ entry, order, keys, now, onOpenIpHelp }: { entry: KiwoomKey; order: OrdersAccount | undefined; keys: readonly KiwoomKey[]; now: number; onOpenIpHelp(): void }) {
  const queryClient = useQueryClient();
  const command = useCommand();
  const [editing, setEditing] = useState(false);
  const [form, dispatch] = useReducer(keyEntryReducer, entry.alias, emptyEntry);
  const locked = entry.link.state === "connecting" || command.busy;
  const keep = (list: KiwoomKeyList) => storeKiwoomKeys(queryClient, list);
  const request = editRequest(form, entry);

  const save = async () => {
    if (!request) return;
    const saved = await command.run(async () => {
      if (request.alias !== null) await keep(await renameKiwoomKey(entry.keyId, { alias: request.alias }));
      if (request.credentials !== null) await keep(await replaceKiwoomKey(entry.keyId, request.credentials));
      if (entry.market) await loadKiwoomLink();
    });
    if (!saved) return;
    setEditing(false);
    dispatch({ type: "reset", alias: request.alias ?? entry.alias });
  };
  const remove = async () => {
    if (!(await confirmAction(removeText(keys, entry, orderInUse(order)), { action: "키 지우기", danger: true }))) return;
    await command.run(async () => {
      await keep(await removeKiwoomKey(entry.keyId));
      if (entry.market) await loadKiwoomLink();
    });
  };

  return (
    <div className="flex flex-col gap-3 px-1 pb-3 pl-5">
      <div className="flex flex-col gap-1">
        <ReadOnlyRow label="앱키" value={maskedAppKey(entry.appKeyTail)} />
        <p className="text-s text-text-3">{entry.source === "env" ? ".env에서 읽음 · 읽기 전용" : "화면에서 저장"}</p>
      </div>
      {entry.source === "env" ? (
        <p className="text-s text-text-3">바꾸려면 .env에서 해당 줄을 지우세요</p>
      ) : editing ? (
        <form aria-label="키 바꾸기" className="flex flex-col gap-2" autoComplete="off" onSubmit={(e) => { e.preventDefault(); if (request && !locked) void save(); }}>
          <KeyFields entry={form} dispatch={dispatch} disabled={locked} keyHint="비우면 그대로" />
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className="tb-btn h-9 px-3" onClick={() => dispatch({ type: "toggleReveal" })}>{form.reveal ? "입력 가리기" : "입력 보기"}</button>
            <button type="submit" className="btn-primary h-9 px-4 disabled:cursor-not-allowed disabled:opacity-50" disabled={locked || !request}>저장</button>
            <button type="button" className="tb-btn h-9 px-3" onClick={() => { setEditing(false); dispatch({ type: "reset", alias: entry.alias }); }}>취소</button>
          </div>
          <SaveNote note={keySaveNote(entry.link)} onOpenIpHelp={onOpenIpHelp} />
        </form>
      ) : (
        <div className="flex flex-wrap gap-2">
          <button type="button" className="tb-btn h-9 px-3" disabled={locked} onClick={() => setEditing(true)}>별칭·키 바꾸기</button>
          <button type="button" className="tb-btn h-9 px-3 text-danger" disabled={locked} onClick={() => void remove()}>지우기</button>
        </div>
      )}
      {order && <KiwoomRowOrders keyId={entry.keyId} order={order} />}
      {!entry.market && <RowConnection entry={entry} now={now} keep={keep} />}
      {command.error && <p role="alert" className="text-m text-danger">{command.error}</p>}
    </div>
  );
}

function RowConnection({ entry, now, keep }: { entry: KiwoomKey; now: number; keep(list: KiwoomKeyList): Promise<void> }) {
  const command = useCommand();
  const { confirmations, setConfirmations, view } = useConfirmations(entry.link, now);
  const connect = async (acknowledged: boolean) => {
    let again = false;
    await command.run(async () => {
      const list = await connectKiwoomKey(entry.keyId, { acknowledged });
      await keep(list);
      again = list.keys.find((key) => key.keyId === entry.keyId)?.link.problem === "authBlocked8050";
    });
    if (again) setConfirmations(NO_CONFIRMATIONS);
  };
  if (!view.connect && !view.disconnect) return null;
  return (
    <div className="flex flex-col items-start gap-2">
      {entry.link.state === "failed" && <p className="text-m leading-relaxed text-text-2">{entry.link.message}</p>}
      {view.needsConfirmations && <Confirm confirmations={confirmations} onConfirm={(next) => setConfirmations(next)} />}
      {view.connect && entry.link.state !== "noKey" && (
        <button type="button" className="tb-btn h-9 px-3 disabled:cursor-not-allowed disabled:opacity-50" disabled={!view.connect.enabled || command.busy} onClick={() => void connect(view.connect!.acknowledged)}>{view.connect.label}</button>
      )}
      {view.disconnect && <button type="button" className="tb-btn h-9 px-3" disabled={command.busy} onClick={() => void command.run(async () => keep(await disconnectKiwoomKey(entry.keyId)))}>연결 끊기</button>}
      {command.error && <p role="alert" className="text-m text-danger">{command.error}</p>}
    </div>
  );
}
