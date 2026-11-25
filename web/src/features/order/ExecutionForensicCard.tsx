import type { DiagnosisTag } from "../../api/generated/DiagnosisTag";
import type { ExecutionForensic } from "../../api/generated/ExecutionForensic";
import { formatPrice } from "../../lib/format";
import { formatFillTime } from "./holdingSummary";
import { SIDE_LABEL } from "./orderRules";

export const DIAGNOSIS_LABEL: Readonly<Record<DiagnosisTag, string>> = {
  iceberg_support: "아이스버그 지지",
  whale_divergence: "고래 다이버전스",
  spoof_chase_trap: "허수벽 추격 함정",
  early_stop_before_program: "프로그램 전 조기청산",
  neutral: "중립",
};

function formatSignedPct(value: number | null): string {
  if (value === null) return "—";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(2)}%`;
}

function formatMfeMae(mfe: number | null, mae: number | null): string {
  if (mfe === null && mae === null) return "—";
  return `${formatSignedPct(mfe)} / ${formatSignedPct(mae)}`;
}

function formatCancelRate(rate: number | null): string {
  if (rate === null) return "—";
  return `${rate.toFixed(1)}%`;
}

function formatProgramDelta(millionWon: number | null): string {
  if (millionWon === null) return "—";
  const sign = millionWon > 0 ? "+" : millionWon < 0 ? "-" : "";
  const abs = Math.abs(millionWon);
  if (abs >= 100) return `${sign}${(abs / 100).toFixed(1)}억`;
  return `${sign}${Math.round(abs).toLocaleString("ko-KR")}백만`;
}

function formatSlippage(ticks: number | null): string {
  if (ticks === null) return "—";
  const sign = ticks > 0 ? "+" : "";
  return `${sign}${ticks}틱`;
}

export function ExecutionForensicCard({ item }: { item: ExecutionForensic }) {
  return (
    <section
      className="od-forensic-card"
      data-testid="execution-forensic-card"
      data-diagnosis={item.diagnosis}
      data-collected={item.collected ? "true" : "false"}
    >
      <header className="od-forensic-head">
        <span className="od-forensic-meta">
          <span className="od-time">{formatFillTime(item.time)}</span>
          <strong className="od-forensic-name">{item.name}</strong>
          <span className="od-forensic-side" data-side={item.side}>{SIDE_LABEL[item.side]}</span>
          <span className="od-forensic-price">{formatPrice(item.price, false)}원</span>
        </span>
        <span className="od-forensic-head-tags">
          <span className="od-forensic-badge" data-diagnosis={item.diagnosis}>
            {item.collected ? DIAGNOSIS_LABEL[item.diagnosis] : "미수집"}
          </span>
          <span className="od-forensic-jump">차트 시점 이동</span>
        </span>
      </header>
      {!item.collected ? (
        <div className="od-forensic-empty">
          <strong>미수집 종목</strong>
          <p className="od-forensic-summary">{item.summary}</p>
        </div>
      ) : (
        <>
          <div className="od-forensic-grid">
            <div className="od-forensic-tile">
              <span className="od-forensic-label">MFE / MAE</span>
              <b className="od-forensic-value" data-testid="forensic-mfe-mae">{formatMfeMae(item.mfePct, item.maePct)}</b>
            </div>
            <div className="od-forensic-tile">
              <span className="od-forensic-label">진입초 허수율</span>
              <b className="od-forensic-value" data-testid="forensic-cancel-rate" data-tone={item.preEntryCancelRatePct !== null && item.preEntryCancelRatePct >= 70 ? "danger" : undefined}>
                {formatCancelRate(item.preEntryCancelRatePct)}
              </b>
            </div>
            <div className="od-forensic-tile">
              <span className="od-forensic-label">당시 프로그램</span>
              <b className="od-forensic-value" data-testid="forensic-program-delta" data-tone={item.programDeltaMillionWon === null || item.programDeltaMillionWon === 0 ? undefined : item.programDeltaMillionWon > 0 ? "up" : "down"}>
                {formatProgramDelta(item.programDeltaMillionWon)}
              </b>
            </div>
            <div className="od-forensic-tile">
              <span className="od-forensic-label">슬리피지</span>
              <b className="od-forensic-value" data-testid="forensic-slippage" data-tone={item.slippageTicks === null || item.slippageTicks === 0 ? undefined : item.slippageTicks > 0 ? "danger" : "success"}>
                {formatSlippage(item.slippageTicks)}
              </b>
            </div>
          </div>
          <p className="od-forensic-summary" data-testid="forensic-summary">{item.summary}</p>
        </>
      )}
    </section>
  );
}
