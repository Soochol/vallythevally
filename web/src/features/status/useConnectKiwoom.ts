import { connectKiwoom, connectKiwoomKey, loadKiwoomLink } from "../../api/system";
import { useKiwoomLinkStore } from "../../stores/kiwoomLink";
import { useCommand } from "../system-settings/useCommand";

async function connectMarketSource(): Promise<void> {
  const source = useKiwoomLinkStore.getState().source;
  if (source?.broker === "kis" && source.keyId !== null) {
    await connectKiwoomKey(source.keyId, { acknowledged: false });
    await loadKiwoomLink();
    return;
  }
  await connectKiwoom({ acknowledged: false });
}

export function useConnectKiwoom() {
  const command = useCommand();
  return { busy: command.busy, error: command.error, connect: () => void command.run(connectMarketSource) };
}
