import { useState } from "react";
import { useKiwoomKeys } from "../../api/system";
import { useServerTime } from "../status/useServerTime";
import { KiwoomAccountList } from "./KiwoomAccountList";
import { KiwoomIpHelp } from "./KiwoomIpHelp";
import { KiwoomOrdersCard } from "./KiwoomOrdersCard";
import { KiwoomStatusCard } from "./KiwoomStatusCard";
import { KiwoomUsageCard } from "./KiwoomUsageCard";
import { MarketKeyPicker } from "./MarketKeyPicker";
import { KEY_LIST_REFRESH_MS } from "./kiwoomKeys";
import { useKiwoomPanel } from "./useKiwoomPanel";

export function KiwoomMenuContent() {
  const panel = useKiwoomPanel();
  const keys = useKiwoomKeys(KEY_LIST_REFRESH_MS).data?.keys;
  const now = useServerTime();
  const [ipHelpRequests, setIpHelpRequests] = useState(0);
  return (
    <div className="flex flex-col gap-4">
      <KiwoomStatusCard
        label="시세 공급원"
        header={<MarketKeyPicker keys={keys ?? []} now={now} />}
        status={panel.status}
        view={panel.view}
        confirmations={panel.confirmations}
        onConfirm={panel.confirm}
        busy={panel.command.busy}
        onConnect={panel.connect}
        onDisconnect={panel.disconnect}
        onRecheckTokenFile={panel.recheckTokenFile}
      />
      {panel.command.error && <p role="alert" className="text-m text-danger">{panel.command.error}</p>}
      <KiwoomAccountList onOpenIpHelp={() => setIpHelpRequests((n) => n + 1)} />
      <KiwoomOrdersCard />
      <KiwoomUsageCard />
      <KiwoomIpHelp status={panel.status} openByItself={panel.view.ipHelpOpensByItself} openRequests={ipHelpRequests} checked={panel.checkedIp} onChecked={panel.setCheckedIp} command={panel.ipCommand} />
      {panel.ipCommand.error && <p role="alert" className="text-m text-danger">{panel.ipCommand.error}</p>}
    </div>
  );
}
