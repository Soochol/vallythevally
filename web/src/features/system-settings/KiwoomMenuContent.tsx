import { useState } from "react";
import { useKiwoomKeys } from "../../api/system";
import { useMarketSource } from "../../stores/kiwoomLink";
import { useServerTime } from "../status/useServerTime";
import { KiwoomAccountList } from "./KiwoomAccountList";
import { KiwoomIpHelp } from "./KiwoomIpHelp";
import { KiwoomStatusCard } from "./KiwoomStatusCard";
import { KiwoomUsageCard } from "./KiwoomUsageCard";
import { MarketKeyPicker } from "./MarketKeyPicker";
import { feedLine, KEY_LIST_REFRESH_MS, marketKeyOf } from "./kiwoomKeys";
import { useKiwoomPanel } from "./useKiwoomPanel";
import { useMarketPanel } from "./useMarketPanel";

export function KiwoomMenuContent() {
  const keys = useKiwoomKeys(KEY_LIST_REFRESH_MS).data?.keys;
  const marketKey = keys && marketKeyOf(keys);
  const kiwoom = useKiwoomPanel();
  const panel = useMarketPanel(kiwoom, marketKey);
  const source = useMarketSource();
  const now = useServerTime();
  const [ipHelpRequests, setIpHelpRequests] = useState(0);
  const line = feedLine(source, keys ?? []);
  return (
    <div className="flex flex-col gap-4">
      <KiwoomStatusCard
        label="시세 공급원"
        header={<MarketKeyPicker keys={keys ?? []} now={now} />}
        footer={line && <p className="border-t border-line pt-2 text-s text-text-2" data-testid="feed-line">{line}</p>}
        broker={marketKey?.broker}
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
      <KiwoomUsageCard />
      <KiwoomIpHelp status={kiwoom.status} openByItself={kiwoom.view.ipHelpOpensByItself} openRequests={ipHelpRequests} checked={kiwoom.checkedIp} onChecked={kiwoom.setCheckedIp} command={kiwoom.ipCommand} />
      {kiwoom.ipCommand.error && <p role="alert" className="text-m text-danger">{kiwoom.ipCommand.error}</p>}
    </div>
  );
}
