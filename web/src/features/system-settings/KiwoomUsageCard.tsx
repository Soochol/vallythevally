import { memo, useState } from "react";
import { useKiwoomUsage } from "../../api/system";
import { ChevronIcon } from "../icons";
import { HIT_LIMIT_LABEL, RATE_LIMITED_LABEL, USAGE_REFRESH_MS, usageView } from "./kiwoomUsage";

const HEADERS = ["TR", "1분 전송", "1초 최대", "기다림 최대", "제한 응답"];

export const KiwoomUsageCard = memo(function KiwoomUsageCard() {
  const usage = useKiwoomUsage(USAGE_REFRESH_MS).data;
  const [userChoice, setUserChoice] = useState<boolean | null>(null);
  if (!usage) return null;
  const view = usageView(usage);
  const limited = view.totalRateLimited > 0 || view.rows.some((row) => row.warning);
  const open = userChoice ?? limited;
  const summary = (
    <>
      <span className="text-m font-semibold">호출 한도</span>
      <span className="text-s text-text-2">
        <span data-testid="usage-minute">지난 1분({view.lastMinute})</span> · <span data-testid="usage-total-limited">서버를 켠 뒤 제한 응답 {view.totalRateLimited}건</span>
      </span>
    </>
  );
  return (
    <section aria-label="호출 한도" className="rounded-m border border-line bg-surface">
      {view.emptyMessage !== null ? (
        <div className="flex flex-col gap-1 p-4">
          <h3 className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">{summary}</h3>
          <p className="text-m text-text-2">{view.emptyMessage}</p>
        </div>
      ) : (
        <>
          <h3>
            <button type="button" aria-expanded={open} className="flex min-h-11 w-full flex-wrap items-center justify-between gap-x-4 gap-y-1 rounded-m px-4 py-2 text-left hover:bg-hover" onClick={() => setUserChoice(!open)}>
              {summary}
              <span aria-hidden="true" className={`flex-none text-text-3 transition-transform ${open ? "" : "-rotate-90"}`}><ChevronIcon size={16} /></span>
            </button>
          </h3>
          {open && (
            <div className="overflow-x-auto px-4 pb-4">
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
                      <td className="px-2 py-1.5 text-right">{row.sent}</td>
                      <td className="px-2 py-1.5 text-right">{row.peak}</td>
                      <td className="px-2 py-1.5 text-right">{row.maxWait}</td>
                      <td className="px-2 py-1.5 text-right">{row.rateLimited}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  );
});
