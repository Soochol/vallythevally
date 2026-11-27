import { type RefObject, useEffect, useRef, useState } from "react";
import type { KiwoomLinkStatus } from "../../api/generated/KiwoomLinkStatus";
import type { PublicIpCheck } from "../../api/generated/PublicIpCheck";
import { checkPublicIp } from "../../api/system";
import { formatKstMinute } from "../../chart/time";
import { ChevronIcon, ExternalLinkIcon } from "../icons";
import { PORTAL_URL } from "./KiwoomKeyFields";
import { ipDiffers } from "./kiwoomPanel";
import type { Command } from "./useCommand";

const PORTAL_STEPS = [
  "키움 Open API 포털에 로그인합니다.",
  "앱 관리에서 지정단말기(허용 IP) 항목을 엽니다.",
  "위에서 확인한 IP를 추가하고 저장합니다.",
  "이 화면으로 돌아와 확인 칸을 체크합니다.",
];

interface Props {
  status: KiwoomLinkStatus | null;
  openByItself: boolean;
  checked: PublicIpCheck | null;
  onChecked(result: PublicIpCheck): void;
  command: Command;
  openRequests?: number;
  inline?: boolean;
}

export function KiwoomIpHelp({ status, openByItself, checked, onChecked, command, openRequests = 0, inline = false }: Props) {
  const [userChoice, setUserChoice] = useState<boolean | null>(null);
  const section = useRef<HTMLElement>(null);
  const checkButton = useRef<HTMLButtonElement>(null);
  const answered = useRef(openRequests);
  const open = inline || (userChoice ?? openByItself);

  useEffect(() => {
    if (openRequests > 0) setUserChoice(true);
  }, [openRequests]);

  useEffect(() => {
    if (openRequests === answered.current || !open) return;
    answered.current = openRequests;
    section.current?.scrollIntoView({ block: "nearest" });
    checkButton.current?.focus({ preventScroll: true });
  }, [openRequests, open]);

  const check = () => void command.run(async () => onChecked(await checkPublicIp()));

  return (
    <section ref={section} aria-label="IP 도움" className={inline ? "flex flex-col gap-3 border-t border-line pt-3" : "rounded-m border border-line bg-surface"}>
      {!inline && (
        <button type="button" aria-expanded={open} className="flex h-11 w-full items-center justify-between rounded-m px-4 text-left font-semibold hover:bg-hover" onClick={() => setUserChoice(!open)}>
          <span>공인 IP 확인 · 포털 안내</span>
          <span aria-hidden="true" className={`text-text-3 transition-transform ${open ? "" : "-rotate-90"}`}><ChevronIcon /></span>
        </button>
      )}
      {open && (
        <div className={inline ? "flex flex-col gap-4" : "flex flex-col gap-4 px-4 pb-4"}>
          <IpCheck status={status} checked={checked} command={command} onCheck={check} checkButton={checkButton} />
          <div className="flex flex-col gap-2">
            {inline && <p className="font-semibold">포털에 등록</p>}
            <ol className="flex list-decimal flex-col gap-1 pl-5 text-m text-text-2">
              {PORTAL_STEPS.map((step) => <li key={step}>{step}</li>)}
            </ol>
            <p className="text-s text-text-3">메뉴 이름은 실제 화면과 다를 수 있습니다.</p>
            <a className="btn self-start" href={PORTAL_URL} target="_blank" rel="noopener noreferrer">키움 포털 열기 (새 탭) <ExternalLinkIcon size={14} /></a>
          </div>
        </div>
      )}
    </section>
  );
}

function IpCheck({ status, checked, command, onCheck, checkButton }: { status: KiwoomLinkStatus | null; checked: PublicIpCheck | null; command: Command; onCheck(): void; checkButton: RefObject<HTMLButtonElement | null> }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    if (!checked) return;
    try {
      await navigator.clipboard.writeText(checked.ip);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className="flex flex-col items-start gap-2">
      <button ref={checkButton} type="button" className="btn" disabled={command.busy} onClick={onCheck}>내 공인 IP 확인</button>
      <p className="text-s text-text-2">누를 때만 서버가 외부 서비스에 한 번 묻습니다. 서버의 공인 IP가 그 서비스에 알려지고, 키와 토큰은 보내지 않습니다.</p>
      {checked && (
        <div className="flex w-full flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="flex h-9 min-w-0 items-center rounded-m border border-[var(--line-strong)] bg-bg px-3 font-mono text-text">{checked.ip}</span>
            <button type="button" className="btn" onClick={() => void copy()}>{copied ? "복사됨" : "복사"}</button>
          </div>
          <p className="text-s text-text-2">마지막 확인 <time>{formatKstMinute(checked.checkedAt)}</time></p>
        </div>
      )}
      {status?.registeredIp && <p className="text-s text-text-2">마지막으로 포털에 등록한 IP <span className="break-all font-mono">{status.registeredIp.ip}</span></p>}
      {ipDiffers(checked?.ip ?? null, status) && <p role="alert" className="text-s text-warning">지금 공인 IP와 다릅니다. 공유기·통신사에서 IP가 바뀌었을 수 있습니다</p>}
    </div>
  );
}
