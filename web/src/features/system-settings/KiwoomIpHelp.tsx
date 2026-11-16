import { useState } from "react";
import type { KiwoomLinkStatus } from "../../api/generated/KiwoomLinkStatus";
import type { PublicIpCheck } from "../../api/generated/PublicIpCheck";
import { checkPublicIp } from "../../api/system";
import { formatKstClockSeconds } from "../../chart/time";
import { ipDiffers } from "./kiwoomPanel";
import type { Command } from "./useCommand";

const PORTAL_URL = "https://openapi.kiwoom.com";

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
}

export function KiwoomIpHelp({ status, openByItself, checked, onChecked, command }: Props) {
  const [userChoice, setUserChoice] = useState<boolean | null>(null);
  const [copied, setCopied] = useState(false);
  const open = userChoice ?? openByItself;
  const check = () => void command.run(async () => onChecked(await checkPublicIp()));
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
    <section aria-label="IP 도움" className="rounded-m border border-line bg-surface">
      <button type="button" aria-expanded={open} className="flex h-11 w-full items-center justify-between px-4 text-left text-m font-semibold" onClick={() => setUserChoice(!open)}>
        <span>공인 IP 확인 · 포털 안내</span>
        <span aria-hidden="true" className="text-text-3">{open ? "접기" : "펼치기"}</span>
      </button>
      {open && (
        <div className="flex flex-col gap-4 px-4 pb-4">
          <div className="flex flex-col items-start gap-2">
            <button type="button" className="tb-btn h-9 px-3" disabled={command.busy} onClick={check}>내 공인 IP 확인</button>
            <p className="text-s text-text-3">누를 때만 서버가 외부 서비스에 한 번 묻습니다. 서버의 공인 IP가 그 서비스에 알려지고, 키와 토큰은 보내지 않습니다.</p>
            {checked && (
              <div className="flex flex-col gap-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="min-w-0 break-all font-mono text-m text-text">{checked.ip}</span>
                  <button type="button" className="tb-btn h-7 px-2 text-s" onClick={() => void copy()}>{copied ? "복사됨" : "복사"}</button>
                </div>
                <p className="text-s text-text-3">마지막 확인 <time>{formatKstClockSeconds(checked.checkedAt)}</time></p>
              </div>
            )}
            {status?.registeredIp && <p className="text-s text-text-3">마지막으로 포털에 등록한 IP <span className="break-all font-mono">{status.registeredIp.ip}</span></p>}
            {ipDiffers(checked?.ip ?? null, status) && <p role="alert" className="text-s text-warning">지금 공인 IP와 다릅니다. 공유기·통신사에서 IP가 바뀌었을 수 있습니다</p>}
          </div>
          <ol className="flex list-decimal flex-col gap-1 pl-5 text-m text-text-2">
            {PORTAL_STEPS.map((step) => <li key={step}>{step}</li>)}
          </ol>
          <p className="text-s text-text-3">메뉴 이름은 실제 화면과 다를 수 있습니다.</p>
          <a className="tb-btn inline-flex h-9 items-center self-start px-3" href={PORTAL_URL} target="_blank" rel="noopener noreferrer">키움 포털 열기 (새 탭)</a>
        </div>
      )}
    </section>
  );
}
