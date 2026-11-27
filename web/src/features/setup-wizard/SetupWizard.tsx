import { type ReactNode, useEffect, useRef, useState } from "react";
import { loadKiwoomLink } from "../../api/system";
import type { InitialSyncChoice } from "../../api/generated/InitialSyncChoice";
import { useAccountStore } from "../../stores/account";
import { useKiwoomLinkStore } from "../../stores/kiwoomLink";
import { useSetupChangeStore } from "../../stores/setupChange";
import { PROVIDER_NAME } from "../account/provider";
import { BrandIcon } from "../icons";
import { Kbd } from "../ui/Kbd";
import { KiwoomIpHelp } from "../system-settings/KiwoomIpHelp";
import { KiwoomKeyForm } from "../system-settings/KiwoomKeyForm";
import { KeyPortalNote } from "../system-settings/KiwoomKeyFields";
import { Confirm, KiwoomStatusCard } from "../system-settings/KiwoomStatusCard";
import { useKiwoomPanel } from "../system-settings/useKiwoomPanel";
import { SetupStepPanel, SyncNote } from "./SetupStepPanel";
import { advancesOnConnect, canAdvance, firstStep, isSkippable, MARK_TEXT, nextStep, previousStep, skipTarget, stepMark, wizardSteps, type WizardStepId } from "./wizardSteps";
import { needsChoice, useWizardStore } from "./wizardOpen";

const STEP_TITLE: Record<WizardStepId, string> = {
  prepare: "키움 포털에서 준비합니다",
  paste: "키를 붙여넣습니다",
  setup: "셋업을 고릅니다",
  done: "준비를 마쳤습니다",
};

const STEP_HELP: Partial<Record<WizardStepId, string>> = {
  prepare: "키움은 포털에 등록한 공인 IP에서 오는 요청만 받습니다. 앱키를 받고 지금 공인 IP를 등록해 두세요.",
  paste: "키움 Open API 앱키와 시크릿을 넣습니다. 키는 이 PC에만 저장되고 계정 서버에는 올라가지 않습니다. 저장하면 바로 키움에 연결하고 진행을 여기서 보입니다.",
};

const NEXT_THINGS: readonly { title: string; body: ReactNode }[] = [
  { title: "종목 찾기", body: <><Kbd>/</Kbd> 키로 종목을 검색해 차트에 엽니다</> },
  { title: "관심종목", body: "차트 옆 목록에 자주 보는 종목을 모읍니다" },
  { title: "계정 셋업", body: "시스템 설정의 계정에서 다른 PC와 맞추는 상태를 봅니다" },
];

export function SetupWizard() {
  const link = useKiwoomLinkStore((s) => s.status);
  const choosing = useAccountStore((s) => needsChoice(s.status));
  const hide = useWizardStore((s) => s.hide);
  useEffect(() => {
    const load = new AbortController();
    void loadKiwoomLink(load.signal);
    return () => load.abort();
  }, []);
  useEffect(() => {
    if (choosing) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || document.querySelectorAll('[role="dialog"], [role="alertdialog"]').length > 1) return;
      hide();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [choosing, hide]);
  return (
    <div role="dialog" aria-modal="true" aria-labelledby="setup-wizard-title" className="fixed inset-0 z-[var(--z-modal)] overflow-y-auto bg-bg">
      <div className="mx-auto flex min-h-full w-full flex-col items-center gap-4 px-4 py-6 md:py-10">
        {link === null ? <p className="text-m text-text-2">연결 상태를 불러오는 중입니다</p> : <WizardBody initial={firstStep(link, choosing)} />}
      </div>
    </div>
  );
}

function Logo() {
  return (
    <span className="flex items-center gap-2 text-l font-bold">
      <BrandIcon size={24} />
      vally
    </span>
  );
}

function WizardBody({ initial }: { initial: WizardStepId }) {
  const account = useAccountStore((s) => s.status);
  const hide = useWizardStore((s) => s.hide);
  const panel = useKiwoomPanel(true);
  const [step, setStep] = useState<WizardStepId>(initial);
  const [chosen, setChosen] = useState<InitialSyncChoice | null>(null);
  const [editingKey, setEditingKey] = useState(false);
  const choosing = needsChoice(account);
  const [withChoice, setWithChoice] = useState(choosing);
  if (choosing && !withChoice) setWithChoice(true);

  const connected = panel.status?.state === "connected";
  const wasConnected = useRef(connected);
  useEffect(() => {
    if (advancesOnConnect(step, wasConnected.current, connected)) setStep(nextStep(step, withChoice));
    wasConnected.current = connected;
  }, [connected]);

  if (account?.state !== "signed_in" || !panel.status) return null;

  const steps = wizardSteps(withChoice);
  const facts = { link: panel.status, portalIpConfirmed: panel.confirmations.registeredIp };
  const label = steps.find((s) => s.id === step)!.label;
  const help = STEP_HELP[step];
  const ipHelp = <KiwoomIpHelp status={panel.status} inline openByItself checked={panel.checkedIp} onChecked={panel.setCheckedIp} command={panel.ipCommand} />;

  return (
    <>
      <header className="flex w-full max-w-140 items-center justify-between">
        <Logo />
        {isSkippable(step) && <button type="button" className="btn" onClick={() => setStep(skipTarget(choosing))}>나중에 하기</button>}
      </header>
      <section className="flex w-full max-w-140 flex-col gap-4 rounded-l border border-line bg-surface p-5 md:p-6">
        <ol aria-label="설정 단계" className={`grid gap-2 ${withChoice ? "grid-cols-4" : "grid-cols-3"}`}>
          {steps.map((s, i) => {
            const mark = stepMark(steps, s.id, step, facts);
            return (
              <li key={s.id} aria-current={mark === "current" ? "step" : undefined} data-mark={mark} className="flex min-w-0 flex-col gap-1 break-keep text-s text-text-3 data-[mark=current]:font-semibold data-[mark=current]:text-accent data-[mark=done]:text-success data-[mark=later]:text-warning">
                <span aria-hidden="true" className="h-1 rounded-full bg-current opacity-60" />
                <span>{i + 1}. {s.label}</span>
                <span className="min-h-4 text-xs">{MARK_TEXT[mark]}</span>
              </li>
            );
          })}
        </ol>

        <div className="flex flex-col gap-1">
          <h1 id="setup-wizard-title" className="text-s font-semibold text-text-2">처음 설정</h1>
          <h2 className="text-h font-semibold">{step === "done" && !connected ? "나중에 이어서 설정합니다" : STEP_TITLE[step]}</h2>
          <p className="text-m text-text-2">{PROVIDER_NAME[account.provider]} 계정으로 로그인했습니다. 키움 연결과 셋업을 차례로 맞춥니다.</p>
        </div>

        <div role="group" aria-label={label} className="flex flex-col gap-4">
          {help && <p className="text-m text-text-2">{help}</p>}
          {step === "prepare" && (
            <ol aria-label="키 준비 목록" className="flex flex-col gap-3">
              <CheckItem number={1} title="포털에서 앱키 받기" done={panel.status.keySource !== "none"}>
                <KeyPortalNote />
              </CheckItem>
              <CheckItem number={2} title="공인 IP 확인하고 포털에 등록하기" done={panel.confirmations.registeredIp}>
                {ipHelp}
                {panel.ipCommand.error && <p role="alert" className="text-m text-danger">{panel.ipCommand.error}</p>}
                <Confirm lock={false} confirmations={panel.confirmations} onConfirm={panel.confirm} />
              </CheckItem>
            </ol>
          )}
          {step === "paste" && (
            <>
              <KiwoomKeyForm status={panel.status} command={panel.command} onSaved={panel.clearConfirmations} onOpenIpHelp={() => setStep("prepare")} onEditingChange={setEditingKey} />
              {panel.status.state !== "noKey" && !editingKey && (
                <KiwoomStatusCard status={panel.status} view={panel.view} confirmations={panel.confirmations} onConfirm={panel.confirm} busy={panel.command.busy} onConnect={panel.connect} onDisconnect={panel.disconnect} onRecheckTokenFile={panel.recheckTokenFile} ipHelp={ipHelp} />
              )}
              {panel.command.error && <p role="alert" className="text-m text-danger">{panel.command.error}</p>}
            </>
          )}
          {step === "setup" && <SetupStepPanel sync={account.sync} chosen={chosen} onChosen={(choice) => { setChosen(choice); useSetupChangeStore.getState().settleChoice(); setStep("done"); }} />}
          {step === "done" && (
            <>
              {connected ? (
                <p role="status" className="text-m text-success">키움에 연결했습니다. 다음부터는 서버를 켜면 자동으로 연결합니다</p>
              ) : (
                <p className="text-m text-text-2">아직 키움에 연결하지 않았습니다. 시스템 설정의 키움에서 언제든 이어서 넣을 수 있습니다.</p>
              )}
              <SyncNote sync={account.sync} chosen={chosen} />
              <ul aria-label="다음 할 일" className="grid grid-cols-3 gap-2 max-md:grid-cols-1">
                {NEXT_THINGS.map((thing) => (
                  <li key={thing.title} className="flex flex-col gap-1 rounded-m border border-line bg-raised p-3">
                    <span className="text-m font-semibold">{thing.title}</span>
                    <span className="text-s text-text-2">{thing.body}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>

        <div className="flex items-center gap-2 border-t border-line pt-4">
          {step !== "prepare" && step !== "setup" && <button type="button" className="btn" onClick={() => setStep(previousStep(step))}>이전</button>}
          <span className="flex-1" />
          {step === "prepare" && <button type="button" className="btn-primary" disabled={!canAdvance(step, facts)} onClick={() => setStep(nextStep(step, withChoice))}>다음</button>}
          {step === "paste" && connected && !editingKey && <button type="button" className="btn-primary" onClick={() => setStep(nextStep(step, withChoice))}>다음</button>}
          {step === "setup" && !choosing && <button type="button" className="btn-primary" onClick={() => setStep("done")}>다음</button>}
          {step === "done" && <button type="button" className="btn-primary" onClick={hide}>차트 보기</button>}
        </div>
      </section>
    </>
  );
}

function CheckItem({ number, title, done, children }: { number: number; title: string; done: boolean; children: ReactNode }) {
  return (
    <li className="flex flex-col gap-3 rounded-m border border-line bg-raised p-3">
      <div className="flex items-center gap-2">
        <span aria-hidden="true" className="grid size-5 flex-none place-items-center rounded-full bg-accent-soft text-xs font-semibold text-accent">{number}</span>
        <h3 className="text-m font-semibold">{title}</h3>
        {done && <span className="text-s text-success">끝</span>}
      </div>
      {children}
    </li>
  );
}
