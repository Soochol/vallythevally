import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useReducer, useState } from "react";
import type { KiwoomKey } from "../../api/generated/KiwoomKey";
import type { Broker } from "../../api/generated/Broker";
import type { KiwoomKeyList } from "../../api/generated/KiwoomKeyList";
import { addKiwoomKey, checkOrdersAccount, loadKiwoomLink, storeKiwoomKeys } from "../../api/system";
import { BROKERS, brokerOrder, takesAccountNumber } from "./brokers";
import { type AccountCheck, accountCheckLine, kisListingOf, kisMissingHtsId } from "./kisAccount";
import { KeyFields, KisAccountFields } from "./KiwoomKeyFields";
import { SaveNote } from "./KiwoomKeyForm";
import { addedKey, addInput, addResult, addSteps, atLimit, canAdd, defaultAlias, emptyEntry, keyEntryReducer } from "./kiwoomKeys";
import { useCommand } from "./useCommand";

type Phase = { step: "closed" } | { step: "broker" } | { step: "input"; broker: Broker } | { step: "confirm"; keyId: string | null };

const CLOSED: Phase = { step: "closed" };

export function AddKeyPanel({ list, now, onOpenIpHelp, onOpenOrders }: { list: KiwoomKeyList; now: number; onOpenIpHelp(): void; onOpenOrders(keyId: string): void }) {
  const queryClient = useQueryClient();
  const command = useCommand();
  const brokers = brokerOrder();
  const steps = addSteps(brokers);
  const [phase, setPhase] = useState<Phase>(CLOSED);
  const [entry, dispatch] = useReducer(keyEntryReducer, defaultAlias(list.keys, brokers[0]!), emptyEntry);
  const empty = list.keys.length === 0;
  const showingResult = phase.step === "confirm" && list.keys.some((key) => key.keyId === phase.keyId);
  const shown: Phase = showingResult ? phase : empty ? (phase.step === "input" || phase.step === "broker" ? phase : firstInputPhase(steps, brokers)) : phase.step === "confirm" ? CLOSED : phase;
  const close = () => {
    dispatch({ type: "reset", alias: defaultAlias(list.keys, brokers[0]!) });
    setPhase(CLOSED);
  };

  useEffect(() => {
    if (empty) dispatch({ type: "reset", alias: defaultAlias([], brokers[0]!) });
  }, [empty]);

  if (shown.step === "closed") {
    const full = brokers.every((broker) => atLimit(list, broker));
    return full ? (
      <p className="text-m text-text-2">키는 {list.limit}개까지입니다</p>
    ) : (
      <button type="button" className="tb-btn h-9 self-start px-3" onClick={() => { dispatch({ type: "reset", alias: defaultAlias(list.keys, brokers[0]!) }); setPhase(firstInputPhase(steps, brokers)); }}>＋ 계좌 연결 더하기</button>
    );
  }

  if (shown.step === "broker") {
    return (
      <div className="flex flex-col gap-2" aria-label="증권사 고르기" role="group">
        {brokers.map((broker) => (
          <button key={broker} type="button" className="tb-btn h-9 justify-start px-3 disabled:opacity-50" disabled={atLimit(list, broker)} onClick={() => { dispatch({ type: "reset", alias: defaultAlias(list.keys, broker) }); setPhase({ step: "input", broker }); }}>
            {BROKERS[broker].name}{atLimit(list, broker) ? ` · ${list.limit}개까지입니다` : ""}
          </button>
        ))}
        {!empty && <button type="button" className="tb-btn h-9 self-start px-3" onClick={close}>취소</button>}
      </div>
    );
  }

  if (shown.step === "confirm") {
    const added = list.keys.find((key) => key.keyId === shown.keyId);
    const result = added ? addResult(added.link, now) : null;
    return (
      <div role="status" className="flex flex-col items-start gap-2" data-testid="add-result">
        {added && result && <p className="text-m text-text"><span className="font-semibold">{added.alias}</span> · <span data-tone={result.tone}>{result.text}</span></p>}
        {added && kisListingOf(added) !== null && <KisAccountResult added={added} />}
        <div className="flex flex-wrap gap-2">
          <button type="button" className="tb-btn h-9 px-3" onClick={close}>닫기</button>
          {added && kisListingOf(added) !== null && <button type="button" className="btn-primary h-9 px-4" onClick={() => { const keyId = added.keyId; close(); onOpenOrders(keyId); }}>주문 사용 켜기로</button>}
        </div>
      </div>
    );
  }

  const inputBroker = shown.broker;
  const save = async () => {
    const input = addInput(entry, inputBroker);
    let keyId: string | null = null;
    const saved = await command.run(async () => {
      const next = await addKiwoomKey(input);
      await storeKiwoomKeys(queryClient, next);
      keyId = addedKey(list.keys, next.keys)?.keyId ?? null;
      if (list.keys.length === 0) await loadKiwoomLink();
    });
    if (!saved) return;
    dispatch({ type: "reset", alias: "" });
    setPhase({ step: "confirm", keyId });
  };

  return (
    <form aria-label="키 더하기" className="flex flex-col gap-2" autoComplete="off" onSubmit={(e) => { e.preventDefault(); if (canAdd(entry, inputBroker) && !command.busy) void save(); }}>
      {brokers.length > 1 && <p className="text-s font-semibold text-text-2" data-testid="add-broker">{BROKERS[inputBroker].name}</p>}
      <KeyFields entry={entry} dispatch={dispatch} disabled={command.busy} />
      {takesAccountNumber(inputBroker) && <KisAccountFields entry={entry} dispatch={dispatch} disabled={command.busy} />}
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="tb-btn h-9 px-3" onClick={() => dispatch({ type: "toggleReveal" })}>{entry.reveal ? "입력 가리기" : "입력 보기"}</button>
        <button type="submit" className="btn-primary h-9 px-4 disabled:cursor-not-allowed disabled:opacity-50" disabled={command.busy || !canAdd(entry, inputBroker)}>저장하고 연결</button>
        {!empty && <button type="button" className="tb-btn h-9 px-3" onClick={close}>취소</button>}
      </div>
      {inputBroker === "kis" ? (
        <>
          <SaveNote note="kisConnectsAtOnce" />
          <p className="text-s text-text-3">이 계좌로 잔고 조회를 한 번 해 계좌를 확인합니다. 주문 사용은 따로 켭니다</p>
        </>
      ) : (
        <SaveNote note="connectsAtOnce" onOpenIpHelp={onOpenIpHelp} />
      )}
      {command.error && <p role="alert" className="text-m text-danger">{command.error}</p>}
    </form>
  );
}

function firstInputPhase(steps: readonly string[], brokers: readonly Broker[]): Phase {
  return steps[0] === "broker" ? { step: "broker" } : { step: "input", broker: brokers[0]! };
}

function KisAccountResult({ added }: { added: KiwoomKey }) {
  const [check, setCheck] = useState<AccountCheck>({ state: "waiting" });
  const connected = added.link.state === "connected";
  const settled = added.link.state === "failed" || added.link.state === "disconnected" || added.link.state === "noKey";

  useEffect(() => {
    if (!connected) return;
    let live = true;
    setCheck({ state: "checking" });
    checkOrdersAccount(added.keyId).then(
      (result) => { if (live) setCheck({ state: "ok", tail: result.accountTail }); },
      (error: unknown) => { if (live) setCheck({ state: "failed", message: error instanceof Error ? error.message : "계좌를 확인하지 못했습니다" }); },
    );
    return () => { live = false; };
  }, [added.keyId, connected]);

  const line = accountCheckLine(check);
  return (
    <>
      {!settled && <p className="text-m text-text" data-testid="kis-account-check" data-tone={line.tone}>{line.text}</p>}
      {kisMissingHtsId(kisListingOf(added)) && <p className="text-s text-text-3">HTS ID가 없어 체결 알림은 받지 않습니다</p>}
      <p className="text-s text-text-3">주문은 아직 꺼져 있습니다</p>
    </>
  );
}
