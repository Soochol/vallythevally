import { useEffect, useState } from "react";
import { loadKiwoomLink } from "../../api/system";
import type { InitialSyncChoice } from "../../api/generated/InitialSyncChoice";
import { useAccountStore } from "../../stores/account";
import { useKiwoomLinkStore } from "../../stores/kiwoomLink";
import { useSetupChangeStore } from "../../stores/setupChange";
import { PROVIDER_NAME } from "../account/provider";
import { KiwoomIpHelp } from "../system-settings/KiwoomIpHelp";
import { KiwoomKeyForm } from "../system-settings/KiwoomKeyForm";
import { Confirm, KiwoomStatusCard } from "../system-settings/KiwoomStatusCard";
import { useKiwoomPanel } from "../system-settings/useKiwoomPanel";
import { SetupStepPanel } from "./SetupStepPanel";
import { canAdvance, firstStep, isSkippable, MARK_TEXT, nextStep, previousStep, skipToSetup, stepMark, WIZARD_STEPS, type WizardStepId } from "./wizardSteps";
import { needsChoice, useWizardStore } from "./wizardOpen";

const STEP_HELP: Record<"key" | "ip" | "connect", string> = {
  key: "키움 Open API 앱키와 시크릿을 넣습니다. 키는 이 PC에만 저장되고 계정 서버에는 올라가지 않습니다.",
  ip: "키움은 등록한 공인 IP에서 오는 요청만 받습니다. 키를 저장하면 바로 연결하므로, 먼저 지금 공인 IP를 확인해 포털에 등록하세요.",
  connect: "키를 저장하면 서버가 바로 키움에 연결합니다. 진행과 결과를 여기서 봅니다.",
};

export function SetupWizard() {
  const link = useKiwoomLinkStore((s) => s.status);
  useEffect(() => {
    const load = new AbortController();
    void loadKiwoomLink(load.signal);
    return () => load.abort();
  }, []);
  return (
    <div role="dialog" aria-modal="true" aria-labelledby="setup-wizard-title" className="fixed inset-0 z-[60] overflow-y-auto bg-bg">
      <div className="mx-auto flex min-h-full w-full max-w-[640px] flex-col gap-4 px-4 py-6 md:py-10">
        <h1 id="setup-wizard-title" className="text-l font-semibold">처음 설정</h1>
        {link === null ? <p className="text-m text-text-2">연결 상태를 불러오는 중입니다</p> : <WizardBody initial={firstStep(link)} />}
      </div>
    </div>
  );
}

function WizardBody({ initial }: { initial: WizardStepId }) {
  const account = useAccountStore((s) => s.status);
  const hide = useWizardStore((s) => s.hide);
  const panel = useKiwoomPanel(true);
  const [step, setStep] = useState<WizardStepId>(initial);
  const [chosen, setChosen] = useState<InitialSyncChoice | null>(null);
  if (account?.state !== "signed_in" || !panel.status) return null;

  const facts = { link: panel.status, portalIpConfirmed: panel.confirmations.registeredIp };
  const choosing = needsChoice(account);

  return (
    <>
      <p className="text-m text-text-2">{PROVIDER_NAME[account.provider]} 계정으로 로그인했습니다. 키움 연결과 셋업을 차례로 맞춥니다.</p>
      <ol aria-label="설정 단계" className="grid grid-cols-5 gap-1">
        {WIZARD_STEPS.map((s, i) => {
          const mark = stepMark(s.id, step, facts);
          return (
            <li key={s.id} aria-current={mark === "current" ? "step" : undefined} data-mark={mark} className="flex min-w-0 flex-col gap-1 break-keep text-center text-xs text-text-3 data-[mark=current]:font-semibold data-[mark=current]:text-accent data-[mark=done]:text-success data-[mark=later]:text-warning">
              <span aria-hidden="true" className="h-1 rounded-full bg-current opacity-60" />
              <span>{i + 1}. {s.label}</span>
              <span className="min-h-4">{MARK_TEXT[mark]}</span>
            </li>
          );
        })}
      </ol>

      <div className="flex flex-col gap-4" aria-label={WIZARD_STEPS.find((s) => s.id === step)!.label} role="group">
        {step !== "setup" && step !== "login" && <p className="text-m text-text-2">{STEP_HELP[step]}</p>}
        {step === "key" && <KiwoomKeyForm status={panel.status} command={panel.command} onSaved={panel.clearConfirmations} onOpenIpHelp={() => setStep("ip")} />}
        {step === "ip" && (
          <>
            <KiwoomIpHelp status={panel.status} openByItself checked={panel.checkedIp} onChecked={panel.setCheckedIp} command={panel.ipCommand} />
            {panel.ipCommand.error && <p role="alert" className="text-m text-danger">{panel.ipCommand.error}</p>}
            <Confirm lock={false} confirmations={panel.confirmations} onConfirm={panel.confirm} />
          </>
        )}
        {step === "connect" && (
          <KiwoomStatusCard status={panel.status} view={panel.view} confirmations={panel.confirmations} onConfirm={panel.confirm} busy={panel.command.busy} onConnect={panel.connect} onDisconnect={panel.disconnect} onRecheckTokenFile={panel.recheckTokenFile} />
        )}
        {step === "connect" && panel.status.state === "connected" && <p role="status" className="text-m text-success">다음부터는 서버를 켜면 자동으로 연결합니다</p>}
        {step === "setup" && <SetupStepPanel sync={account.sync} chosen={chosen} onChosen={(choice) => { setChosen(choice); useSetupChangeStore.getState().settleChoice(); }} />}
        {step !== "setup" && panel.command.error && <p role="alert" className="text-m text-danger">{panel.command.error}</p>}
      </div>

      <div className="mt-auto flex flex-wrap items-center gap-2 pt-2">
        {step !== "ip" && <button type="button" className="tb-btn h-9 px-3" onClick={() => setStep(previousStep(step))}>이전</button>}
        <span className="flex-1" />
        {isSkippable(step) && <button type="button" className="tb-btn h-9 px-3" onClick={() => setStep(skipToSetup)}>나중에 하기</button>}
        {isSkippable(step) && <button type="button" className="btn-primary h-9 px-4 disabled:cursor-not-allowed disabled:opacity-50" disabled={!canAdvance(step, facts)} onClick={() => setStep(nextStep(step))}>다음</button>}
        {step === "setup" && !choosing && <button type="button" className="btn-primary h-9 px-4" onClick={hide}>닫기</button>}
      </div>
    </>
  );
}
