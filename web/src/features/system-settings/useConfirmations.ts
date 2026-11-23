import { useEffect, useRef, useState } from "react";
import type { Broker } from "../../api/generated/Broker";
import type { KiwoomLinkStatus } from "../../api/generated/KiwoomLinkStatus";
import { type Confirmations, NO_CONFIRMATIONS, panelView } from "./kiwoomPanel";

export function useConfirmations(link: KiwoomLinkStatus | null, now: number, holdConfirmations = false, broker: Broker = "kiwoom") {
  const [confirmations, setConfirmations] = useState<Confirmations>(NO_CONFIRMATIONS);
  const view = panelView(link, now, confirmations, broker);

  const appKeyTail = link?.appKeyTail;
  useEffect(() => setConfirmations(NO_CONFIRMATIONS), [appKeyTail]);

  const previousStage = useRef(view.stage);
  useEffect(() => {
    if (previousStage.current === "connecting" && view.stage === "authBlocked") setConfirmations(NO_CONFIRMATIONS);
    previousStage.current = view.stage;
  }, [view.stage]);

  const keepsConfirmations = holdConfirmations || view.needsConfirmations || view.stage === "connecting";
  useEffect(() => {
    if (!keepsConfirmations) setConfirmations(NO_CONFIRMATIONS);
  }, [keepsConfirmations]);

  return { confirmations, setConfirmations, view };
}
