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

  const keepsConfirmations = view.needsConfirmations || view.stage === "connecting";
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

  return (
    <div className="flex flex-col gap-4">
      <KiwoomStatusCard
        status={status}
        view={view}
        confirmations={confirmations}
        onConfirm={(next, registeredIpChecked) => void confirm(next, registeredIpChecked)}
        busy={command.busy}
        onConnect={(acknowledged) => void connect(acknowledged)}
        onDisconnect={() => void command.run(disconnectKiwoom)}
        onRecheckTokenFile={() => void command.run(recheckKiwoomTokenFile)}
      />
      {command.error && <p role="alert" className="text-m text-danger">{command.error}</p>}
      <KiwoomKeyForm status={status} command={command} onSaved={() => setConfirmations(NO_CONFIRMATIONS)} />
      <KiwoomIpHelp status={status} openByItself={view.ipHelpOpensByItself} checked={checkedIp} onChecked={setCheckedIp} command={ipCommand} />
      {ipCommand.error && <p role="alert" className="text-m text-danger">{ipCommand.error}</p>}
    </div>
  );
}
