import type { ReactNode } from "react";
import type { Broker } from "../../api/generated/Broker";
import type { KiwoomLinkStatus } from "../../api/generated/KiwoomLinkStatus";
import { useSystemSettings } from "../../api/system";
import { formatKstClockSeconds, formatKstMinute } from "../../chart/time";
import { linkDotTone } from "./linkDot";
import { BROKERS } from "./brokers";
import { CONNECT_STEPS, connectBlockReason, type Confirmations, formatRemaining, IN_USE_ELSEWHERE_NOTICE, type PanelView } from "./kiwoomPanel";

const titlesOf = (broker: Broker): Record<PanelView["stage"], string> => ({
  loading: "연결 상태를 불러오는 중입니다",
  noKey: "키 없음",
  disconnected: "연결 안 함",
  connecting: "연결 중",
  connectingWait: "발급 간격 대기",
  connected: "연결됨",
  wait: "발급 간격 대기",
  authBlocked: "인증 차단",
  keyNeedsCheck: "키 확인 필요",
  network: `${BROKERS[broker].shortName}에 닿지 못함`,
  tokenFileUnusable: "토큰 파일 사용 불가",
  keyFileUnusable: "키 파일 사용 불가",
  pathStopped: "멈춤",
  inUseElsewhere: "다른 프로그램이 사용 중",
});

const FIRST_STEPS = ["포털에서 앱키 받기", "공인 IP 등록", "여기에 붙여넣기"];

interface Props {
  status: KiwoomLinkStatus | null;
  view: PanelView;
  confirmations: Confirmations;
  onConfirm(next: Confirmations, registeredIpChecked: boolean): void;
  busy: boolean;
  onConnect(acknowledged: boolean): void;
  onDisconnect(): void;
  onRecheckTokenFile(): void;
  label?: string;
  heading?: string;
  description?: string;
  header?: ReactNode;
  footer?: ReactNode;
  ipHelp?: ReactNode;
  broker?: Broker;
}

export function KiwoomStatusCard({ status, view, confirmations, onConfirm, busy, onConnect, onDisconnect, onRecheckTokenFile, label = "연결 상태", heading, description, header, footer, ipHelp, broker = "kiwoom" }: Props) {
  const failing = linkDotTone(status) === "red";
  const blockReason = connectBlockReason(view, confirmations);
  return (
    <section aria-label={label} className="flex flex-col gap-3 rounded-m border border-line bg-surface p-4">
      {heading && (
        <div className="flex flex-col gap-0.5">
          <h3 className="text-m font-semibold">{heading}</h3>
          {description && <p className="text-s text-text-2">{description}</p>}
        </div>
      )}
      {header}
      <div className="flex items-center gap-2">
        <span aria-hidden="true" className="conn-dot" data-tone={linkDotTone(status)} />
        <h3 className="text-m font-semibold">{titlesOf(broker)[view.stage]}</h3>
        {status?.environment === "mock" && <span className="mock-badge" data-testid="kiwoom-environment">모의투자</span>}
      </div>
      {status && view.stage !== "inUseElsewhere" && <p className="text-m leading-relaxed text-text-2">{status.message}</p>}
      {view.stage === "inUseElsewhere" && <p className="text-m leading-relaxed text-text" data-testid="in-use-elsewhere">{IN_USE_ELSEWHERE_NOTICE}</p>}
      {view.stage === "noKey" && <FirstSteps />}
      {status && view.stage === "connecting" && <Steps step={status.step} />}
      {status && view.stage === "connected" && <ConnectedFacts status={status} />}
      {view.countdown && status?.retryAt != null && <Waiting retryAt={status.retryAt} remaining={view.countdown.remainingSeconds} progress={view.countdown.progress} automatic={view.stage === "connectingWait"} failing={failing} />}
      {view.startNote && <p className="text-m text-text">{view.startNote}</p>}
      {view.stage === "keyNeedsCheck" && <p className="text-m text-text">{status?.keySource === "env" ? "앱키·시크릿을 확인하세요." : "앱키·시크릿을 확인하세요. 새 키를 저장하면 풀립니다."}</p>}
      {view.stage === "pathStopped" && <p className="text-m text-text">서버 로그를 확인하세요. 이 상태만 서버를 다시 켜야 풀립니다.</p>}
      {view.stage === "tokenFileUnusable" && broker === "kiwoom" && <TokenFile busy={busy} onRecheck={onRecheckTokenFile} />}
      {view.needsConfirmations && ipHelp}
      {view.needsConfirmations && <Confirm confirmations={confirmations} onConfirm={onConfirm} />}
      {view.connect && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <button type="button" className="btn-primary" disabled={!view.connect.enabled || busy} onClick={() => onConnect(view.connect!.acknowledged)}>
            {view.connect.label}
          </button>
          {blockReason && <p className="min-w-0 text-s text-text-2">{blockReason}</p>}
          {view.connect.readyNotice && <p className="text-s text-success">지금 연결할 수 있습니다</p>}
        </div>
      )}
      {view.disconnect && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <button type="button" className="btn" disabled={busy} onClick={onDisconnect}>연결 끊기</button>
          {view.disconnectNote && <p className="min-w-0 text-s text-text-2">{view.disconnectNote}</p>}
        </div>
      )}
      {footer}
    </section>
  );
}

function FirstSteps() {
  return (
    <ol aria-label="처음 연결하는 순서" className="grid grid-cols-3 gap-2 max-md:grid-cols-1">
      {FIRST_STEPS.map((step, index) => (
        <li key={step} className="flex items-center gap-2 rounded-m border border-line bg-raised px-3 py-2 text-m">
          <span aria-hidden="true" className="grid size-5 flex-none place-items-center rounded-full bg-accent-soft text-xs font-semibold text-accent">{index + 1}</span>
          <span className="min-w-0">{step}</span>
        </li>
      ))}
    </ol>
  );
}

function Steps({ step }: { step: KiwoomLinkStatus["step"] }) {
  const at = CONNECT_STEPS.findIndex((s) => s.step === step);
  return (
    <ol aria-label="연결 단계" className="grid grid-cols-4 gap-2 max-md:grid-cols-2">
      {CONNECT_STEPS.map((s, i) => (
        <li key={s.step} aria-current={i === at ? "step" : undefined} data-done={i < at} className="flex flex-col gap-1 text-s text-text-3 aria-[current=step]:text-accent data-[done=true]:text-success">
          <span aria-hidden="true" className="h-1 rounded-full bg-current opacity-60" />
          <span>{i + 1}. {s.label}</span>
        </li>
      ))}
    </ol>
  );
}

function ConnectedFacts({ status }: { status: KiwoomLinkStatus }) {
  const facts: [string, string][] = [
    ["토큰 만료", status.tokenExpiresAt === null ? "—" : formatKstMinute(status.tokenExpiresAt)],
    ["실시간 등록", status.realtimeRegistered === null ? "—" : `${status.realtimeRegistered}종목`],
    ["종목 수", status.symbolCount === null ? "—" : `${status.symbolCount}종목`],
  ];
  return (
    <dl className="grid grid-cols-3 gap-3 text-m max-md:grid-cols-1">
      {facts.map(([label, value]) => (
        <div key={label} className="flex flex-col gap-0.5">
          <dt className="text-s text-text-3">{label}</dt>
          <dd className="text-text">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function Waiting({ retryAt, remaining, progress, automatic, failing }: { retryAt: number; remaining: number; progress: number; automatic: boolean; failing: boolean }) {
  return (
    <div className="flex flex-col gap-2">
      <p className={`text-m ${failing ? "text-danger" : "text-text"}`}>
        {automatic ? (
          remaining > 0 ? <>{formatRemaining(remaining)} 뒤 저절로 이어 연결합니다</> : "곧 저절로 이어 연결합니다"
        ) : remaining > 0 ? <>다음 발급 가능 <time>{formatKstClockSeconds(retryAt)}</time> ({formatRemaining(remaining)} 뒤)</> : "발급 간격이 지났습니다"}
      </p>
      <div aria-hidden="true" className="h-1 overflow-hidden rounded-full bg-raised">
        <div className={`h-full ${failing ? "bg-danger" : "bg-warning"}`} style={{ width: `${Math.round(progress * 100)}%` }} />
      </div>
    </div>
  );
}

function TokenFile({ busy, onRecheck }: { busy: boolean; onRecheck(): void }) {
  const path = useSystemSettings().data?.tokenPath;
  return (
    <div className="flex flex-col items-start gap-2">
      {path && <p className="break-all font-mono text-s text-text-2">{path}</p>}
      <button type="button" className="btn" disabled={busy} onClick={onRecheck}>파일 다시 확인</button>
      <p className="text-s text-text-2">파일만 다시 읽습니다. 키움에는 아무것도 보내지 않습니다.</p>
    </div>
  );
}

export function Confirm({ confirmations, onConfirm, lock = true }: { confirmations: Confirmations; onConfirm(next: Confirmations, registeredIpChecked: boolean): void; lock?: boolean }) {
  return (
    <fieldset className="flex flex-col gap-1 border-0 p-0">
      <legend className="sr-only">다시 연결하기 전 확인</legend>
      <label className="flex min-h-8 items-center gap-2 text-m">
        <input type="checkbox" className="size-4 accent-accent" checked={confirmations.registeredIp} onChange={(e) => onConfirm({ ...confirmations, registeredIp: e.target.checked }, e.target.checked)} />
        포털에 지금 공인 IP를 등록했습니다
      </label>
      {lock && <label className="flex min-h-8 items-center gap-2 text-m">
        <input type="checkbox" className="size-4 accent-accent" checked={confirmations.lockChecked} onChange={(e) => onConfirm({ ...confirmations, lockChecked: e.target.checked }, false)} />
        반복 발급 잠금이 풀렸는지 확인했습니다
      </label>}
    </fieldset>
  );
}
