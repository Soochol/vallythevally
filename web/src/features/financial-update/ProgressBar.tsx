import type { FinancialJobProgress } from "../../lib/financialJob";

export function ProgressBar({ progress }: { progress: FinancialJobProgress }) {
  return (
    <div role="progressbar" aria-label="재무 업데이트 진행률" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.floor(progress.percent)} className="fu-progress">
      {progress.stages.map((stage) => (
        <span key={stage.name} data-stage={stage.name} className="fu-progress-stage"><i style={{ transform: `scaleX(${stage.fill})` }} /></span>
      ))}
    </div>
  );
}
