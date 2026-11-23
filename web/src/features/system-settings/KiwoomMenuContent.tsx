import { useCallback, useState } from "react";
import { useKiwoomKeys } from "../../api/system";
import { useMarketSource } from "../../stores/kiwoomLink";
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
  const [ipHelpRequests, setIpHelpRequests] = useState(0);
  const openIpHelp = useCallback(() => setIpHelpRequests((n) => n + 1), []);
  const line = feedLine(source, keys ?? []);
  const ipHelpProps = { status: kiwoom.status, checked: kiwoom.checkedIp, onChecked: kiwoom.setCheckedIp, command: kiwoom.ipCommand, openRequests: ipHelpRequests };
  const ipHelpInline = panel.view.ipHelpOpensByItself;
  return (
    <div className="flex flex-col gap-4">
      <KiwoomStatusCard
        label="시세 공급원"
        heading="시세 공급원"
        description="차트·호가·체결 시세를 받는 키입니다"
        header={<MarketKeyPicker keys={keys ?? []} />}
        footer={line && <p className="border-t border-line pt-2 text-s text-text-2" data-testid="feed-line">{line}</p>}
        ipHelp={<KiwoomIpHelp {...ipHelpProps} inline openByItself />}
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
      <KiwoomAccountList onOpenIpHelp={openIpHelp} />
      <KiwoomUsageCard />
      {!ipHelpInline && <KiwoomIpHelp {...ipHelpProps} openByItself={kiwoom.view.ipHelpOpensByItself} />}
      {kiwoom.ipCommand.error && <p role="alert" className="text-m text-danger">{kiwoom.ipCommand.error}</p>}
    </div>
  );
}
