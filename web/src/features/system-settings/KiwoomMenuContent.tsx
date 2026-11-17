import { KiwoomIpHelp } from "./KiwoomIpHelp";
import { KiwoomKeyForm } from "./KiwoomKeyForm";
import { KiwoomStatusCard } from "./KiwoomStatusCard";
import { useKiwoomPanel } from "./useKiwoomPanel";

export function KiwoomMenuContent() {
  const panel = useKiwoomPanel();
  return (
    <div className="flex flex-col gap-4">
      <KiwoomStatusCard
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
      <KiwoomKeyForm status={panel.status} command={panel.command} onSaved={panel.clearConfirmations} />
      <KiwoomIpHelp status={panel.status} openByItself={panel.view.ipHelpOpensByItself} checked={panel.checkedIp} onChecked={panel.setCheckedIp} command={panel.ipCommand} />
      {panel.ipCommand.error && <p role="alert" className="text-m text-danger">{panel.ipCommand.error}</p>}
    </div>
  );
}
