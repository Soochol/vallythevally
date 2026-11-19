import { useKiwoomUsage } from "../../api/system";
import { HIT_LIMIT_LABEL, RATE_LIMITED_LABEL, USAGE_REFRESH_MS, usageView } from "./kiwoomUsage";

const HEADERS = ["TR", "1분 전송", "1초 최대", "기다림 최대", "제한 응답"];

export function KiwoomUsageCard() {
  const usage = useKiwoomUsage(USAGE_REFRESH_MS).data;
  if (!usage) return null;
  const view = usageView(usage);
  return (
    <section aria-label="호출 한도" className="flex flex-col gap-3 rounded-m border border-line bg-surface p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h3 className="text-m font-semibold">호출 한도</h3>
        <p className="text-s text-text-3">
          <span data-testid="usage-minute">지난 1분({view.lastMinute})</span> · <span data-testid="usage-total-limited">서버를 켠 뒤 제한 응답 {view.totalRateLimited}건</span>
        </p>
      </div>
      {view.emptyMessage !== null ? (
        <p className="text-m text-text-2">{view.emptyMessage}</p>
      ) : (
        <div className="overflow-x-auto">
          <table aria-label="TR별 호출 한도 사용률" className="w-full border-collapse text-m">
            <thead>
              <tr>
                {HEADERS.map((header, i) => (
                  <th key={header} scope="col" className={`whitespace-nowrap border-b border-line px-2 py-1.5 font-normal text-text-3 ${i === 0 ? "text-left" : "text-right"}`}>{header}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {view.rows.map((row) => (
                <tr key={row.apiId} data-warning={row.warning || undefined} className={row.warning ? "text-warning" : "text-text"}>
                  <th scope="row" className="whitespace-nowrap px-2 py-1.5 text-left font-normal">
                    <span className="font-mono">{row.apiId}</span>
                    {row.meaning !== null && <span className="ml-2">{row.meaning}</span>}
                    {row.hitLimit && <span className="ml-2 font-semibold">{HIT_LIMIT_LABEL}</span>}
                    {row.warning && <span className="ml-2 font-semibold">{RATE_LIMITED_LABEL}</span>}
                  </th>
                  <td className="px-2 py-1.5 text-right font-mono">{row.sent}</td>
                  <td className="px-2 py-1.5 text-right font-mono">{row.peak}</td>
                  <td className="px-2 py-1.5 text-right font-mono">{row.maxWait}</td>
                  <td className="px-2 py-1.5 text-right font-mono">{row.rateLimited}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
