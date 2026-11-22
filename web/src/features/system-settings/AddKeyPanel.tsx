import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useReducer, useState } from "react";
import type { Broker } from "../../api/generated/Broker";
import type { KiwoomKeyList } from "../../api/generated/KiwoomKeyList";
import { addKiwoomKey, KIWOOM_KEYS_QUERY_KEY, loadKiwoomLink } from "../../api/system";
import { BROKERS, brokerOrder } from "./brokers";
import { KeyFields } from "./KiwoomKeyFields";
import { SaveNote } from "./KiwoomKeyForm";
import { addedKey, addResult, addSteps, atLimit, canAdd, defaultAlias, emptyEntry, keyEntryReducer } from "./kiwoomKeys";
import { useCommand } from "./useCommand";

type Phase = { step: "closed" } | { step: "broker" } | { step: "input"; broker: Broker } | { step: "confirm"; keyId: string | null };

const CLOSED: Phase = { step: "closed" };

export function AddKeyPanel({ list, now, onOpenIpHelp }: { list: KiwoomKeyList; now: number; onOpenIpHelp(): void }) {
  const queryClient = useQueryClient();
  const command = useCommand();
  const brokers = brokerOrder();
  const steps = addSteps(brokers);
  const [phase, setPhase] = useState<Phase>(CLOSED);
  const [entry, dispatch] = useReducer(keyEntryReducer, defaultAlias(list.keys, brokers[0]!), emptyEntry);
  const empty = list.keys.length === 0;
  const showingResult = phase.step === "confirm" && list.keys.some((key) => key.keyId === phase.keyId);
  const shown: Phase = empty && !showingResult ? firstInputPhase(steps, brokers) : phase;
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
        <button type="button" className="tb-btn h-9 self-start px-3" onClick={close}>취소</button>
      </div>
    );
  }

  if (shown.step === "confirm") {
    const added = list.keys.find((key) => key.keyId === shown.keyId);
    const result = added ? addResult(added.link, now) : null;
    return (
      <div role="status" className="flex flex-col items-start gap-2">
        {added && result && <p className="text-m text-text"><span className="font-semibold">{added.alias}</span> · <span data-tone={result.tone}>{result.text}</span></p>}
        <button type="button" className="tb-btn h-9 px-3" onClick={close}>닫기</button>
      </div>
    );
  }

  const save = async () => {
    const input = { alias: entry.alias.trim(), appKey: entry.appKey.trim(), appSecret: entry.appSecret.trim() };
    let keyId: string | null = null;
    const saved = await command.run(async () => {
      const next = await addKiwoomKey(input);
      queryClient.setQueryData(KIWOOM_KEYS_QUERY_KEY, next);
      keyId = addedKey(list.keys, next.keys)?.keyId ?? null;
      if (list.keys.length === 0) await loadKiwoomLink();
    });
    if (!saved) return;
    dispatch({ type: "reset", alias: "" });
    setPhase({ step: "confirm", keyId });
  };

  return (
    <form aria-label="키 더하기" className="flex flex-col gap-2" autoComplete="off" onSubmit={(e) => { e.preventDefault(); if (canAdd(entry) && !command.busy) void save(); }}>
      <KeyFields entry={entry} dispatch={dispatch} disabled={command.busy} />
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="tb-btn h-9 px-3" onClick={() => dispatch({ type: "toggleReveal" })}>{entry.reveal ? "입력 가리기" : "입력 보기"}</button>
        <button type="submit" className="btn-primary h-9 px-4 disabled:cursor-not-allowed disabled:opacity-50" disabled={command.busy || !canAdd(entry)}>저장하고 연결</button>
        {!empty && <button type="button" className="tb-btn h-9 px-3" onClick={close}>취소</button>}
      </div>
      <SaveNote note="connectsAtOnce" onOpenIpHelp={onOpenIpHelp} />
      {command.error && <p role="alert" className="text-m text-danger">{command.error}</p>}
    </form>
  );
}

function firstInputPhase(steps: readonly string[], brokers: readonly Broker[]): Phase {
  return steps[0] === "broker" ? { step: "broker" } : { step: "input", broker: brokers[0]! };
}
