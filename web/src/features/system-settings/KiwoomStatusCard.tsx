import type { KiwoomLinkStatus } from "../../api/generated/KiwoomLinkStatus";
import { useSystemSettings } from "../../api/system";
import { formatKstClockSeconds } from "../../chart/time";
import { linkDotTone } from "./linkDot";
import { CONNECT_STEPS, type Confirmations, formatRemaining, type PanelView } from "./kiwoomPanel";

const dateTime = new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

const TITLES: Record<PanelView["stage"], string> = {
  loading: "연결 상태를 불러오는 중입니다",
  noKey: "키 없음",
  disconnected: "연결 안 함",
  connecting: "연결 중",
  connectingWait: "발급 간격 대기",
  connected: "연결됨",
  wait: "발급 간격 대기",
  authBlocked: "인증 차단",
  keyNeedsCheck: "키 확인 필요",
  network: "키움에 닿지 못함",
  tokenFileUnusable: "토큰 파일 사용 불가",
  keyFileUnusable: "키 파일 사용 불가",
  pathStopped: "멈춤",
};

interface Props {
  status: KiwoomLinkStatus | null;
  view: PanelView;
  confirmations: Confirmations;
  onConfirm(next: Confirmations, registeredIpChecked: boolean): void;
  busy: boolean;
  onConnect(acknowledged: boolean): void;
  onDisconnect(): void;
  onRecheckTokenFile(): void;
}

export function KiwoomStatusCard({ status, view, confirmations, onConfirm, busy, onConnect, onDisconnect, onRecheckTokenFile }: Props) {
  return (
    <section aria-label="연결 상태" className="flex flex-col gap-3 rounded-m border border-line bg-surface p-4">
      <div className="flex items-center gap-2">
        <span aria-hidden="true" className="conn-dot" data-tone={linkDotTone(status)} />
        <h3 className="text-m font-semibold">{TITLES[view.stage]}</h3>
      </div>
      {status?.environment === "mock" && <p className="text-s text-warning" data-testid="kiwoom-environment">투자구분 · 모의투자</p>}
      {status && <p className="text-m leading-relaxed text-text-2">{status.message}</p>}
      {status && view.stage === "connecting" && <Steps step={status.step} />}
      {status && view.stage === "connected" && <ConnectedFacts status={status} />}
      {view.countdown && status?.retryAt != null && <Waiting retryAt={status.retryAt} remaining={view.countdown.remainingSeconds} progress={view.countdown.progress} automatic={view.stage === "connectingWait"} />}
      {view.startNote && <p className="text-m text-text">{view.startNote}</p>}
      {view.stage === "keyNeedsCheck" && <p className="text-m text-text">{status?.keySource === "env" ? "앱키·시크릿을 확인하세요." : "앱키·시크릿을 확인하세요. 새 키를 저장하면 풀립니다."}</p>}
      {view.stage === "pathStopped" && <p className="text-m text-text">서버 로그를 확인하세요. 이 상태만 서버를 다시 켜야 풀립니다.</p>}
      {view.stage === "tokenFileUnusable" && <TokenFile busy={busy} onRecheck={onRecheckTokenFile} />}
      {view.needsConfirmations && <Confirm confirmations={confirmations} onConfirm={onConfirm} />}
      {view.connect && (
        <div className="flex flex-col items-start gap-2">
          <button type="button" className="btn-primary h-9 px-4 disabled:cursor-not-allowed disabled:opacity-50" disabled={!view.connect.enabled || busy} onClick={() => onConnect(view.connect!.acknowledged)}>
            {view.connect.label}
          </button>
          {view.connect.readyNotice && <p className="text-s text-success">지금 연결할 수 있습니다</p>}
          {view.stage === "noKey" && <p className="text-s text-text-3">키를 먼저 저장하세요</p>}
        </div>
      )}
      {view.disconnect && (
        <div className="flex flex-col items-start gap-1">
          <button type="button" className="tb-btn h-9 px-3" disabled={busy} onClick={onDisconnect}>연결 끊기</button>
          {view.disconnectNote && <p className="text-s text-text-3">{view.disconnectNote}</p>}
        </div>
      )}
    </section>
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
    ["토큰 만료", status.tokenExpiresAt === null ? "—" : dateTime.format(status.tokenExpiresAt * 1000)],
    ["실시간 등록", status.realtimeRegistered === null ? "—" : `${status.realtimeRegistered}종목`],
    ["종목 수", status.symbolCount === null ? "—" : `${status.symbolCount}종목`],
  ];
  return (
    <dl className="grid grid-cols-3 gap-3 text-m max-md:grid-cols-1">
      {facts.map(([label, value]) => (
        <div key={label} className="flex flex-col gap-0.5">
          <dt className="text-s text-text-3">{label}</dt>
          <dd className="font-mono text-text">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function Waiting({ retryAt, remaining, progress, automatic }: { retryAt: number; remaining: number; progress: number; automatic: boolean }) {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-m text-text">
        {automatic ? (
          remaining > 0 ? <>{formatRemaining(remaining)} 뒤 저절로 이어 연결합니다</> : "곧 저절로 이어 연결합니다"
        ) : remaining > 0 ? <>다음 발급 가능 <time className="font-mono">{formatKstClockSeconds(retryAt)}</time> ({formatRemaining(remaining)} 뒤)</> : "발급 간격이 지났습니다"}
      </p>
      <div aria-hidden="true" className="h-1 overflow-hidden rounded-full bg-raised">
        <div className="h-full bg-warning" style={{ width: `${Math.round(progress * 100)}%` }} />
      </div>
    </div>
  );
}

function TokenFile({ busy, onRecheck }: { busy: boolean; onRecheck(): void }) {
  const path = useSystemSettings().data?.tokenPath;
  return (
    <div className="flex flex-col items-start gap-2">
      {path && <p className="break-all font-mono text-s text-text-2">{path}</p>}
      <button type="button" className="tb-btn h-9 px-3" disabled={busy} onClick={onRecheck}>파일 다시 확인</button>
      <p className="text-s text-text-3">파일만 다시 읽습니다. 키움에는 아무것도 보내지 않습니다.</p>
    </div>
  );
}

export function Confirm({ confirmations, onConfirm, lock = true }: { confirmations: Confirmations; onConfirm(next: Confirmations, registeredIpChecked: boolean): void; lock?: boolean }) {
  return (
    <fieldset className="flex flex-col gap-2 border-0 p-0">
      <legend className="sr-only">다시 연결하기 전 확인</legend>
      <label className="flex items-start gap-2 text-m">
        <input type="checkbox" className="mt-1" checked={confirmations.registeredIp} onChange={(e) => onConfirm({ ...confirmations, registeredIp: e.target.checked }, e.target.checked)} />
        포털에 지금 공인 IP를 등록했습니다
      </label>
      {lock && <label className="flex items-start gap-2 text-m">
        <input type="checkbox" className="mt-1" checked={confirmations.lockChecked} onChange={(e) => onConfirm({ ...confirmations, lockChecked: e.target.checked }, false)} />
        반복 발급 잠금이 풀렸는지 확인했습니다
      </label>}
    </fieldset>
  );
}
