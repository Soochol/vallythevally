import { useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useReducer, useState } from "react";
import type { KiwoomKey } from "../../api/generated/KiwoomKey";
import type { OrdersAccount } from "../../api/generated/OrdersAccount";
import type { KiwoomKeyList } from "../../api/generated/KiwoomKeyList";
import type { KisAccountListing } from "../../api/generated/KisAccountListing";
import { connectKiwoomKey, disconnectKiwoomKey, loadKiwoomLink, removeKiwoomKey, renameKiwoomKey, replaceKiwoomKey, replaceKisAccount, storeKiwoomKeys } from "../../api/system";
import { ChevronIcon } from "../icons";
import { confirmAction } from "../overlay/Confirm";
import { Badge, type BadgeTone } from "../ui/Badge";
import { ENV_ACCOUNT_NOTE, kisAccountText, kisListingOf, kisMissingHtsId, NO_HTS_ID_NOTE } from "./kisAccount";
import { CommandAlert, FormActions, KeyFields, KisAccountFields } from "./KiwoomKeyFields";
import { ReadOnlyRow, SaveNote } from "./KiwoomKeyForm";
import { KiwoomRowOrders } from "./KiwoomRowOrders";
import { Confirm } from "./KiwoomStatusCard";
import { accountRequest, editRequest, emptyEntry, fieldErrors, keyEntryReducer, reasonTone, removeText, shortReason } from "./kiwoomKeys";
import { connectBlockReason, IN_USE_ELSEWHERE_NOTICE, keySaveNote, maskedAppKey, NO_CONFIRMATIONS } from "./kiwoomPanel";
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

const ORDER_TAG_TONE = { on: "warning", off: "neutral", warn: "danger" } as const satisfies Record<"on" | "off" | "warn", BadgeTone>;

export function KiwoomKeyRow({ entry, order, keys, mock, expanded, now, onToggle, onOpenIpHelp }: Props) {
  const reason = shortReason(entry.link, now, entry.broker);
  const listing = kisListingOf(entry);
  const mark = order ? orderMarkOf(order.state) : null;
  const showMark = mark !== null && mark.tone !== "off";
  const markTone: BadgeTone = mark === null ? "neutral" : mock && mark.tone === "on" ? "success" : ORDER_TAG_TONE[mark.tone];
  return (
    <li className="border-b border-line last:border-b-0">
      <button type="button" aria-expanded={expanded} className="flex min-h-11 w-full items-center gap-x-2 rounded-m px-2 py-2 text-left hover:bg-hover max-md:flex-wrap" onClick={onToggle}>
        <span className="flex min-w-0 flex-1 items-center gap-2 max-md:basis-full">
          <span aria-hidden="true" className="conn-dot flex-none" data-tone={linkDotTone(entry.link)} />
          <span className="min-w-0 truncate font-semibold text-text">{entry.alias}</span>
          {entry.market && <Badge tone="accent">시세</Badge>}
          {entry.source === "env" && <Badge>{mock ? "모의투자" : ".env"}</Badge>}
          {showMark && <span className="flex-none" data-testid="key-order-mark" data-tone={mark.tone}><Badge tone={markTone}>{mark.text}</Badge></span>}
        </span>
        <span className="flex min-w-0 items-center gap-2 max-md:basis-full max-md:pl-4">
          {listing ? <span className="flex-none text-s text-text-2" data-testid="key-account">{kisAccountText(listing)}</span> : order && <span className="flex-none text-s text-text-2" data-testid="key-account">{accountNumberOf(order.accountTail)}</span>}
          {reason && <span className={`min-w-0 truncate text-s ${reasonTone(entry.link) === "danger" ? "text-danger" : "text-warning"}`}>{reason}</span>}
          <span aria-hidden="true" className={`ml-auto flex-none text-text-3 transition-transform ${expanded ? "" : "-rotate-90"}`}><ChevronIcon size={16} /></span>
        </span>
      </button>
      {expanded && <KeyDetails entry={entry} order={order} keys={keys} mock={mock} now={now} onOpenIpHelp={onOpenIpHelp} />}
    </li>
  );
}

function Part({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <h4 className="text-s font-semibold text-text-2">{title}</h4>
      {children}
    </div>
  );
}

function KeyDetails({ entry, order, keys, mock, now, onOpenIpHelp }: { entry: KiwoomKey; order: OrdersAccount | undefined; keys: readonly KiwoomKey[]; mock: boolean; now: number; onOpenIpHelp(): void }) {
  const queryClient = useQueryClient();
  const command = useCommand();
  const [editing, setEditing] = useState(false);
  const [form, dispatch] = useReducer(keyEntryReducer, entry.alias, emptyEntry);
  const locked = entry.link.state === "connecting" || command.busy;
  const keep = (list: KiwoomKeyList) => storeKiwoomKeys(queryClient, list);
  const request = editRequest(form, entry);
  const listing = kisListingOf(entry);
  const errors = editing ? fieldErrors(command.error) : {};

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
    const text = removeText(keys, entry, orderInUse(order));
    if (!(await confirmAction(text.title, { action: "키 지우기", danger: true, detail: text.detail }))) return;
    await command.run(async () => {
      await keep(await removeKiwoomKey(entry.keyId));
      if (entry.market) await loadKiwoomLink();
    });
  };

  return (
    <div className="flex flex-col gap-4 px-2 pb-3 pl-6 max-md:pl-2">
      <Part title="키">
        <ReadOnlyRow label="앱키" value={maskedAppKey(entry.appKeyTail)} />
        <p className="text-s text-text-2">{entry.source === "env" ? ".env에서 읽음 · 읽기 전용" : "화면에서 저장"}</p>
        {entry.source === "env" ? (
          <p className="text-s text-text-2">바꾸려면 .env에서 해당 줄을 지우세요</p>
        ) : editing ? (
          <form aria-label="키 바꾸기" className="flex flex-col gap-3" autoComplete="off" onSubmit={(e) => { e.preventDefault(); if (request && !locked) void save(); }}>
            <KeyFields entry={form} dispatch={dispatch} disabled={locked} keyHint="비우면 그대로" errors={errors} />
            <FormActions>
              <button type="button" className="btn" onClick={() => { setEditing(false); dispatch({ type: "reset", alias: entry.alias }); }}>취소</button>
              <button type="submit" className="btn-primary" disabled={locked || !request}>저장</button>
            </FormActions>
            <SaveNote note={keySaveNote(entry.link, entry.broker)} onOpenIpHelp={onOpenIpHelp} />
          </form>
        ) : (
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn" disabled={locked} onClick={() => setEditing(true)}>별칭·키 바꾸기</button>
          </div>
        )}
        {listing && <KisAccountSection entry={entry} listing={listing} keep={keep} locked={locked} />}
      </Part>
      {order && <KiwoomRowOrders entry={entry} order={order} mock={mock} />}
      {!entry.market && <RowConnection entry={entry} now={now} keep={keep} />}
      <CommandAlert error={command.error} mapped={Object.keys(errors).length > 0} />
      {entry.source !== "env" && !editing && (
        <div className="flex justify-end">
          <button type="button" className="btn text-danger" disabled={locked} onClick={() => void remove()}>지우기</button>
        </div>
      )}
    </div>
  );
}

function RowConnection({ entry, now, keep }: { entry: KiwoomKey; now: number; keep(list: KiwoomKeyList): Promise<void> }) {
  const command = useCommand();
  const { confirmations, setConfirmations, view } = useConfirmations(entry.link, now, false, entry.broker);
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
  const showConnect = view.connect && entry.link.state !== "noKey";
  const blockReason = connectBlockReason(view, confirmations);
  return (
    <Part title="연결">
      {view.stage === "inUseElsewhere" ? <p className="text-m leading-relaxed text-text" data-testid="in-use-elsewhere">{IN_USE_ELSEWHERE_NOTICE}</p> : entry.link.state === "failed" && <p className={`text-m leading-relaxed ${reasonTone(entry.link) === "danger" ? "text-danger" : "text-text-2"}`}>{entry.link.message}</p>}
      {view.needsConfirmations && <Confirm confirmations={confirmations} onConfirm={(next) => setConfirmations(next)} />}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {showConnect && <button type="button" className="btn-primary" disabled={!view.connect!.enabled || command.busy} onClick={() => void connect(view.connect!.acknowledged)}>{view.connect!.label}</button>}
        {view.disconnect && <button type="button" className="btn" disabled={command.busy} onClick={() => void command.run(async () => keep(await disconnectKiwoomKey(entry.keyId)))}>연결 끊기</button>}
        {showConnect && blockReason && <p className="min-w-0 text-s text-text-2">{blockReason}</p>}
      </div>
      <CommandAlert error={command.error} mapped={false} />
    </Part>
  );
}

function KisAccountSection({ entry, listing, keep, locked }: { entry: KiwoomKey; listing: KisAccountListing; keep(list: KiwoomKeyList): Promise<void>; locked: boolean }) {
  const command = useCommand();
  const [editing, setEditing] = useState(false);
  const [form, dispatch] = useReducer(keyEntryReducer, "", emptyEntry);
  const request = accountRequest(form);
  const close = () => {
    setEditing(false);
    dispatch({ type: "reset", alias: "" });
  };
  const save = async () => {
    if (!request) return;
    if (await command.run(async () => keep(await replaceKisAccount(entry.keyId, request)))) close();
  };
  const busy = locked || command.busy;
  const errors = editing ? fieldErrors(command.error) : {};

  return (
    <div className="flex flex-col gap-2" data-testid="kis-account">
      <ReadOnlyRow label="계좌번호" value={kisAccountText(listing)} />
      <ReadOnlyRow label="HTS ID" value={listing.htsIdSet ? "설정됨" : "없음"} />
      {kisMissingHtsId(listing) && <p className="text-s text-warning" data-testid="kis-hts-note">{NO_HTS_ID_NOTE}</p>}
      {listing.source === "env" ? (
        <p className="text-s text-text-2">{ENV_ACCOUNT_NOTE}</p>
      ) : editing ? (
        <form aria-label="계좌 바꾸기" className="flex flex-col gap-3" autoComplete="off" onSubmit={(e) => { e.preventDefault(); if (request && !busy) void save(); }}>
          <KisAccountFields entry={form} dispatch={dispatch} disabled={busy} errors={errors} />
          <FormActions>
            <button type="button" className="btn" onClick={close}>취소</button>
            <button type="submit" className="btn-primary" disabled={busy || !request}>저장</button>
          </FormActions>
        </form>
      ) : (
        <button type="button" className="btn self-start" disabled={busy} onClick={() => setEditing(true)}>{listing.accountTail === null ? "계좌번호 넣기" : "계좌번호·HTS ID 바꾸기"}</button>
      )}
      <CommandAlert error={command.error} mapped={Object.keys(errors).length > 0} />
    </div>
  );
}
