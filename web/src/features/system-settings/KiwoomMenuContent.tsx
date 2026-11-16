import { useEffect, useState } from "react";
import type { PublicIpCheck } from "../../api/generated/PublicIpCheck";
import { connectKiwoom, disconnectKiwoom, recheckKiwoomTokenFile, saveRegisteredIp } from "../../api/system";
import { useKiwoomLinkStore } from "../../stores/kiwoomLink";
import { useServerTime } from "../status/useServerTime";
import { KiwoomIpHelp } from "./KiwoomIpHelp";
import { KiwoomKeyForm } from "./KiwoomKeyForm";
import { KiwoomStatusCard } from "./KiwoomStatusCard";
import { type Confirmations, NO_CONFIRMATIONS, panelView } from "./kiwoomPanel";
import { useCommand } from "./useCommand";

export function KiwoomMenuContent() {
  const status = useKiwoomLinkStore((s) => s.status);
  const now = useServerTime();
  const command = useCommand();
  const ipCommand = useCommand();
  const [confirmations, setConfirmations] = useState<Confirmations>(NO_CONFIRMATIONS);
  const [checkedIp, setCheckedIp] = useState<PublicIpCheck | null>(null);
  const view = panelView(status, now, confirmations);

  useEffect(() => {
    if (!view.needsConfirmations) setConfirmations(NO_CONFIRMATIONS);
  }, [view.needsConfirmations]);

  const confirm = (next: Confirmations, registeredIpChecked: boolean) => {
    setConfirmations(next);
    if (registeredIpChecked && checkedIp) void command.run(() => saveRegisteredIp({ ip: checkedIp.ip }));
  };

  return (
    <div className="flex flex-col gap-4">
      <KiwoomStatusCard
        status={status}
        view={view}
        confirmations={confirmations}
        onConfirm={confirm}
        busy={command.busy}
        onConnect={(acknowledged) => void command.run(() => connectKiwoom({ acknowledged }))}
        onDisconnect={() => void command.run(disconnectKiwoom)}
        onRecheckTokenFile={() => void command.run(recheckKiwoomTokenFile)}
      />
      {command.error && <p role="alert" className="text-m text-danger">{command.error}</p>}
      <KiwoomKeyForm status={status} command={command} />
      <KiwoomIpHelp status={status} openByItself={view.ipHelpOpensByItself} checked={checkedIp} onChecked={setCheckedIp} command={ipCommand} />
      {ipCommand.error && <p role="alert" className="text-m text-danger">{ipCommand.error}</p>}
    </div>
  );
}
