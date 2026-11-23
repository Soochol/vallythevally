import { useQueryClient } from "@tanstack/react-query";
import type { KiwoomKey } from "../../api/generated/KiwoomKey";
import { connectKiwoomKey, disconnectKiwoomKey, loadKiwoomLink, storeKiwoomKeys } from "../../api/system";
import { useServerTime } from "../status/useServerTime";
import { type Confirmations, NO_CONFIRMATIONS } from "./kiwoomPanel";
import { useCommand } from "./useCommand";
import { useConfirmations } from "./useConfirmations";
import type { KiwoomPanel } from "./useKiwoomPanel";

export function useMarketPanel(kiwoom: KiwoomPanel, marketKey: KiwoomKey | undefined): KiwoomPanel {
  const queryClient = useQueryClient();
  const now = useServerTime();
  const command = useCommand();
  const key = marketKey?.broker === "kis" ? marketKey : null;
  const { confirmations, setConfirmations, view } = useConfirmations(key?.link ?? null, now, false, "kis");
  if (key === null) return kiwoom;

  const connect = async (acknowledged: boolean) => {
    await command.run(async () => {
      await storeKiwoomKeys(queryClient, await connectKiwoomKey(key.keyId, { acknowledged }));
      await loadKiwoomLink();
    });
  };
  const disconnect = () =>
    void command.run(async () => {
      await storeKiwoomKeys(queryClient, await disconnectKiwoomKey(key.keyId));
      await loadKiwoomLink();
    });

  return {
    ...kiwoom,
    status: key.link,
    view,
    command,
    confirmations,
    clearConfirmations: () => setConfirmations(NO_CONFIRMATIONS),
    confirm: (next: Confirmations) => void setConfirmations(next),
    connect: (acknowledged: boolean) => void connect(acknowledged),
    disconnect,
    recheckTokenFile: () => undefined,
  };
}
