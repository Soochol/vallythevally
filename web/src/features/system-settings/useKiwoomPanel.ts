import { useEffect, useRef, useState } from "react";
import type { PublicIpCheck } from "../../api/generated/PublicIpCheck";
import { connectKiwoom, disconnectKiwoom, recheckKiwoomTokenFile, saveRegisteredIp } from "../../api/system";
import { useKiwoomLinkStore } from "../../stores/kiwoomLink";
import { useServerTime } from "../status/useServerTime";
import { type Confirmations, NO_CONFIRMATIONS, panelView } from "./kiwoomPanel";
import { useCommand } from "./useCommand";

export function useKiwoomPanel(holdConfirmations = false) {
  const status = useKiwoomLinkStore((s) => s.status);
  const now = useServerTime();
  const command = useCommand();
  const ipCommand = useCommand();
  const [confirmations, setConfirmations] = useState<Confirmations>(NO_CONFIRMATIONS);
  const [checkedIp, setCheckedIp] = useState<PublicIpCheck | null>(null);
  const view = panelView(status, now, confirmations);

  const previousStage = useRef(view.stage);
  useEffect(() => {
    if (previousStage.current === "connecting" && view.stage === "authBlocked") setConfirmations(NO_CONFIRMATIONS);
    previousStage.current = view.stage;
  }, [view.stage]);

  const keepsConfirmations = holdConfirmations || view.needsConfirmations || view.stage === "connecting";
  useEffect(() => {
    if (!keepsConfirmations) setConfirmations(NO_CONFIRMATIONS);
  }, [keepsConfirmations]);

  const confirm = async (next: Confirmations, registeredIpChecked: boolean) => {
    setConfirmations(next);
    if (!registeredIpChecked || !checkedIp) return;
    if (!(await command.run(() => saveRegisteredIp({ ip: checkedIp.ip })))) setConfirmations((c) => ({ ...c, registeredIp: false }));
  };

  const connect = async (acknowledged: boolean) => {
    await command.run(() => connectKiwoom({ acknowledged }));
    if (useKiwoomLinkStore.getState().status?.problem === "authBlocked8050") setConfirmations(NO_CONFIRMATIONS);
  };

  return {
    status,
    view,
    command,
    ipCommand,
    confirmations,
    checkedIp,
    setCheckedIp,
    clearConfirmations: () => setConfirmations(NO_CONFIRMATIONS),
    confirm: (next: Confirmations, registeredIpChecked: boolean) => void confirm(next, registeredIpChecked),
    connect: (acknowledged: boolean) => void connect(acknowledged),
    disconnect: () => void command.run(disconnectKiwoom),
    recheckTokenFile: () => void command.run(recheckKiwoomTokenFile),
  };
}

export type KiwoomPanel = ReturnType<typeof useKiwoomPanel>;
