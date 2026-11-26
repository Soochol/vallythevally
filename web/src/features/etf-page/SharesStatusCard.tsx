import { useState } from "react";
import type { EtfSharesStatus } from "../../api/generated/EtfSharesStatus";
import { Badge } from "../ui/Badge";

const ENV_TEMPLATE = "VALLY_KRX_API_KEY=your_krx_auth_key_here\nVALLY_ETF_SHARES_BACKFILL_DAYS=60\n";

export function SharesNotConfiguredCard({ onOpenAccumulation }: { onOpenAccumulation?: () => void }) {
  const [copied, setCopied] = useState(false);

  const copyTemplate = () => {
    void navigator.clipboard?.writeText(ENV_TEMPLATE).catch(() => {});
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  };

  return (
    <section className="etf-shares-setup etf-card-wide" aria-label="KRX Open API 설정 안내">
      <div className="etf-shares-setup-copy">
        <Badge tone="warning">KRX Open API 미설정</Badge>
        <h3>ETF 상장좌수 · 자금 유출입 수집이 꺼져 있습니다</h3>
        <p>
          상장좌수(LIST_SHRS)와 순자산총액(INVSTASST_NETASST_TOTAMT)은 한국거래소 공식 Open API(etf_bydd_trd)에서 수집합니다.
          인증키가 없으면 이 탭만 안내 상태로 표시되며 기존 ETF 기능은 정상 동작합니다.
        </p>
        <ol className="etf-shares-steps">
          <li>
            <span className="etf-shares-step-num">1</span>
            <div>
              <strong>KRX Open API 인증키 발급</strong>
              <span>openapi.krx.co.kr에서 인증키를 발급받고 ETF 일별매매정보(etf_bydd_trd) 이용을 신청합니다.</span>
            </div>
          </li>
          <li>
            <span className="etf-shares-step-num">2</span>
            <div>
              <strong>서버 환경변수에 인증키 등록</strong>
              <span>VALLY_ENV_FILE 또는 프로세스 환경변수에 VALLY_KRX_API_KEY를 추가합니다.</span>
            </div>
          </li>
          <li>
            <span className="etf-shares-step-num">3</span>
            <div>
              <strong>서버 재시작 시 최근 60영업일 자동 소급 백필</strong>
              <span>최신 영업일부터 역순으로 수집해 즉시 반영하고 매일 19:10(KST) 이후 자동 갱신합니다.</span>
            </div>
          </li>
        </ol>
      </div>
      <div className="etf-shares-setup-aside">
        <pre className="etf-shares-code">
          <code>{ENV_TEMPLATE.trim()}</code>
        </pre>
        <div className="etf-shares-setup-actions">
          <button type="button" className="btn btn-sm" onClick={copyTemplate}>
            {copied ? "복사됨" : "환경변수 예시 복사"}
          </button>
          {onOpenAccumulation !== undefined && (
            <button type="button" className="btn btn-sm" onClick={onOpenAccumulation}>
              동시 매집 탭 보기
            </button>
          )}
        </div>
        <div className="etf-shares-graceful" role="status">
          <strong>기존 ETF 분석 기능은 그대로 동작합니다</strong>
          <span>동시 매집 · 겹침 · 역추적 · 구성 · 편입 변경 · 유사 ETF 탭은 KRX API 키 없이 이용할 수 있습니다.</span>
        </div>
      </div>
    </section>
  );
}

export function SharesStatusBanner({ status }: { status: EtfSharesStatus }) {
  if (status.state === "backfilling") {
    const pct =
      status.backfillTargetDays > 0
        ? Math.min(100, Math.round((status.collectedDays / status.backfillTargetDays) * 100))
        : 0;
    return (
      <div className="etf-shares-banner etf-card-wide" data-tone="info" role="status">
        <div className="etf-shares-banner-copy">
          <strong>과거 상장좌수 백필 진행 중</strong>
          <span>최신 영업일부터 역순으로 수집해 확보된 자료를 먼저 보여 줍니다.</span>
        </div>
        <div className="etf-shares-progress">
          <span className="etf-shares-progress-track" aria-hidden="true">
            <i style={{ width: `${pct}%` }} />
          </span>
          <span className="etf-shares-progress-label">
            {status.collectedDays} / {status.backfillTargetDays}일
          </span>
        </div>
      </div>
    );
  }
  if (status.state === "auth_failed" || status.state === "rate_limited" || status.state === "error") {
    const title =
      status.state === "auth_failed"
        ? "KRX Open API 인증 오류"
        : status.state === "rate_limited"
          ? "KRX Open API 일일 호출 한도 초과"
          : "KRX 상장좌수 갱신 실패";
    return (
      <div className="etf-shares-banner etf-card-wide" data-tone="danger" role="alert">
        <div className="etf-shares-banner-copy">
          <strong>{title}</strong>
          <span>
            {status.message ?? "수집을 일시 중단했습니다."}
            {status.latestDate !== null ? ` · 마지막 성공 기준일 ${status.latestDate} 자료를 유지합니다.` : ""}
          </span>
        </div>
      </div>
    );
  }
  return null;
}
