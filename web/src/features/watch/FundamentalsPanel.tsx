import type { Fundamentals } from "../../api/generated/Fundamentals";
import type { SymbolCode } from "../../api/generated/SymbolCode";
import { ApiRequestError } from "../../api/http";
import { useFundamentals, useSymbolInfo } from "../../api/queries";
import { formatDecimal, formatPrice, formatVolume, formatWonAmount } from "../../lib/format";
import { isIndexCode } from "../../lib/symbol";
import { useCell } from "../../stores/layout";
import { useSelectionStore } from "../../stores/selection";

const won = (x: number) => formatPrice(x, false) + "원";
const times = (x: number) => formatDecimal(x) + "배";
const percent = (x: number) => formatDecimal(x) + "%";

const ROWS: ReadonlyArray<[label: string, pick: (f: Fundamentals) => number | null, format: (x: number) => string]> = [
  ["시가총액", (f) => f.marketCap, formatWonAmount],
  ["상장주식", (f) => f.listedShares, (x) => formatVolume(x) + "주"],
  ["PER", (f) => f.per, times],
  ["PBR", (f) => f.pbr, times],
  ["EPS", (f) => f.eps, won],
  ["BPS", (f) => f.bps, won],
  ["ROE", (f) => f.roe, percent],
  ["외국인 소진율", (f) => f.foreignExhaustionRate, percent],
  ["52주 최고", (f) => f.high52w, (x) => formatPrice(x, false)],
  ["52주 최저", (f) => f.low52w, (x) => formatPrice(x, false)],
];

/** 활성 칸 종목의 기본 정보(frontend.md §2.1 "오른쪽 관심종목"). 지수에는 값이 없어 자리째 숨긴다. */
export function FundamentalsPanel() {
  const slot = useSelectionStore((s) => s.activeSlot);
  const code = useCell(slot).symbol;
  return isIndexCode(code) ? null : <StockFundamentals code={code} />;
}

function StockFundamentals({ code }: { code: SymbolCode }) {
  const name = useSymbolInfo(code).data?.name ?? code;
  const query = useFundamentals(code);
  const error = query.error instanceof ApiRequestError ? query.error : null;
  const retryable = error !== null && error.code !== "unknown_symbol" && !error.manualActionRequired;

  return (
    <section aria-label="종목 정보" aria-busy={query.isPending} className="flex-none border-t border-line px-3 py-2">
      <h2 className="mb-1 flex items-baseline gap-1.5 text-m font-[650]">
        종목 정보 <span className="truncate text-s font-normal text-text-3">{name}</span>
      </h2>
      {error ? (
        <div role="alert" className="text-s text-text-2">
          <p>종목 정보를 받지 못했습니다. {error.message}</p>
          {retryable && (
            <button type="button" className="tb-btn mt-1 text-s" onClick={() => void query.refetch()}>
              다시 시도
            </button>
          )}
        </div>
      ) : (
        <dl className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-s">
          {ROWS.map(([label, pick, format]) => {
            const value = query.data ? pick(query.data) : null;
            return (
              <div key={label} className="flex min-w-0 justify-between gap-1">
                <dt className="truncate text-text-3">{label}</dt>
                <dd className="tabular-nums">{value === null ? "—" : format(value)}</dd>
              </div>
            );
          })}
        </dl>
      )}
    </section>
  );
}
