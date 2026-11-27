import { useMemo, useState } from "react";
import type { DiagnosisTag } from "../../api/generated/DiagnosisTag";
import type { ExecutionForensic } from "../../api/generated/ExecutionForensic";
import { useExecutionForensics, useTradingExecutions } from "../../api/trading";
import { EmptyState, ErrorState, Skeleton } from "../overlay/State";
import "./journalPage.css";

type FilterTag = "all" | DiagnosisTag;

const DIAG_LABELS: Record<DiagnosisTag, { readonly label: string; readonly tone: "good" | "bad" | "neutral" }> = {
  iceberg_support: { label: "아이스버그지지", tone: "good" },
  whale_divergence: { label: "고래이탈", tone: "bad" },
  spoof_chase_trap: { label: "허수추격함정", tone: "bad" },
  early_stop_before_program: { label: "프로그램전손절", tone: "bad" },
  neutral: { label: "중립", tone: "neutral" },
};

function formatPct(value: number | null | undefined): string {
  if (value === null || value === undefined) return "-";
  return `${value > 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function summarize(items: readonly ExecutionForensic[]) {
  const mfeList = items.map((i) => i.mfePct).filter((v): v is number => v !== null && v !== undefined);
  const maeList = items.map((i) => i.maePct).filter((v): v is number => v !== null && v !== undefined);
  const slipList = items.map((i) => i.slippageTicks).filter((v): v is number => v !== null && v !== undefined);
  const wins = items.filter((i) => (i.mfePct ?? 0) > Math.abs(i.maePct ?? 0)).length;
  const avgMfe = mfeList.length > 0 ? mfeList.reduce((a, b) => a + b, 0) / mfeList.length : null;
  const avgMae = maeList.length > 0 ? maeList.reduce((a, b) => a + b, 0) / maeList.length : null;
  const avgSlip = slipList.length > 0 ? slipList.reduce((a, b) => a + b, 0) / slipList.length : null;
  const winRate = items.length > 0 ? (wins / items.length) * 100 : null;
  const profitFactor = avgMfe !== null && avgMae !== null && Math.abs(avgMae) > 0.001 ? avgMfe / Math.abs(avgMae) : null;
  return { avgMfe, avgMae, avgSlip, winRate, profitFactor };
}

function hourlyBuckets(items: readonly ExecutionForensic[]): readonly { readonly hour: string; readonly count: number }[] {
  const counts = new Map<string, number>();
  for (const item of items) {
    const hour = item.time.slice(0, 2);
    if (hour.length === 2) counts.set(`${hour}시`, (counts.get(`${hour}시`) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([hour, count]) => ({ hour, count }));
}

export function JournalPage() {
  const [date, setDate] = useState("");
  const [filter, setFilter] = useState<FilterTag>("all");
  const [selectedOrderNo, setSelectedOrderNo] = useState<string | null>(null);

  const executionsQuery = useTradingExecutions(null, true);
  const forensicsQuery = useExecutionForensics(null, true, date || undefined);

  const items = useMemo(() => forensicsQuery.data?.items ?? [], [forensicsQuery.data]);
  const filtered = useMemo(
    () => (filter === "all" ? items : items.filter((item) => item.diagnosis === filter)),
    [items, filter],
  );
  const selected = useMemo(
    () => filtered.find((item) => item.orderNo === selectedOrderNo) ?? filtered[0] ?? null,
    [filtered, selectedOrderNo],
  );
  const stats = useMemo(() => summarize(items), [items]);
  const buckets = useMemo(() => hourlyBuckets(items), [items]);
  const maxBucket = Math.max(1, ...buckets.map((b) => b.count));

  return (
    <div className="jrn-page" data-testid="journal-page">
      <header className="jrn-head">
        <h1 className="jrn-title">매매 복기 &amp; 포렌식</h1>
        <div className="jrn-seg" role="group" aria-label="진단 필터">
          <button type="button" className="jrn-seg-btn" aria-pressed={filter === "all"} onClick={() => setFilter("all")}>전체</button>
          <button type="button" className="jrn-seg-btn" aria-pressed={filter === "iceberg_support"} onClick={() => setFilter("iceberg_support")}>아이스버그</button>
          <button type="button" className="jrn-seg-btn" aria-pressed={filter === "spoof_chase_trap"} onClick={() => setFilter("spoof_chase_trap")}>허수함정</button>
          <button type="button" className="jrn-seg-btn" aria-pressed={filter === "whale_divergence"} onClick={() => setFilter("whale_divergence")}>고래이탈</button>
          <button type="button" className="jrn-seg-btn" aria-pressed={filter === "early_stop_before_program"} onClick={() => setFilter("early_stop_before_program")}>조기손절</button>
        </div>
        <span className="jrn-spacer" />
        <input
          type="date"
          className="jrn-date"
          aria-label="복기 날짜"
          value={date}
          onChange={(e) => setDate(e.target.value)}
        />
      </header>
      <div className="jrn-body">
        {forensicsQuery.isPending ? (
          <Skeleton label="매매 포렌식 데이터를 불러오는 중" rows={8} />
        ) : forensicsQuery.isError ? (
          <ErrorState message="체결 포렌식 데이터를 불러오지 못했습니다" retry={() => void forensicsQuery.refetch()} />
        ) : (
          <>
            <section className="jrn-kpis" aria-label="성과 요약">
              <div className="jrn-kpi">
                <div className="jrn-kpi-label">총 체결 건수</div>
                <div className="jrn-kpi-val">{executionsQuery.data?.executions.length ?? items.length}건</div>
              </div>
              <div className="jrn-kpi">
                <div className="jrn-kpi-label">유리 진입 비율(승률)</div>
                <div className="jrn-kpi-val">{stats.winRate !== null ? `${stats.winRate.toFixed(1)}%` : "-"}</div>
              </div>
              <div className="jrn-kpi">
                <div className="jrn-kpi-label">MFE/MAE 손익비</div>
                <div className="jrn-kpi-val">{stats.profitFactor !== null ? stats.profitFactor.toFixed(2) : "-"}</div>
              </div>
              <div className="jrn-kpi">
                <div className="jrn-kpi-label">평균 MFE / MAE</div>
                <div className="jrn-kpi-val">
                  <span className="jrn-up">{formatPct(stats.avgMfe)}</span> / <span className="jrn-down">{formatPct(stats.avgMae)}</span>
                </div>
              </div>
              <div className="jrn-kpi">
                <div className="jrn-kpi-label">평균 슬리피지</div>
                <div className="jrn-kpi-val">{stats.avgSlip !== null ? `${stats.avgSlip.toFixed(1)}틱` : "-"}</div>
              </div>
            </section>

            {items.length === 0 ? (
              <EmptyState title="표시할 체결 복기 내역이 없습니다" />
            ) : (
              <>
                <section className="jrn-grid">
                  <div className="jrn-card">
                    <div className="jrn-card-head">
                      <span>{selected ? `${selected.name} (${selected.code}) 포렌식 해부` : "포렌식 해부"}</span>
                      {selected && (
                        <span className="jrn-tag" data-tone={DIAG_LABELS[selected.diagnosis].tone}>
                          {DIAG_LABELS[selected.diagnosis].label}
                        </span>
                      )}
                    </div>
                    {selected && (
                      <>
                        <div className="jrn-metrics">
                          <div className="jrn-metric">
                            <div className="jrn-kpi-label">MFE / MAE</div>
                            <div className="jrn-num" style={{ textAlign: "left", fontWeight: 700 }}>
                              <span className="jrn-up">{formatPct(selected.mfePct)}</span> / <span className="jrn-down">{formatPct(selected.maePct)}</span>
                            </div>
                          </div>
                          <div className="jrn-metric">
                            <div className="jrn-kpi-label">슬리피지 / 진입 전 취소율</div>
                            <div className="jrn-num" style={{ textAlign: "left", fontWeight: 700 }}>
                              {selected.slippageTicks ?? "-"}틱 · {selected.preEntryCancelRatePct !== null && selected.preEntryCancelRatePct !== undefined ? `${selected.preEntryCancelRatePct.toFixed(1)}%` : "-"}
                            </div>
                          </div>
                        </div>
                        <p style={{ fontSize: "12px", color: "var(--text-2)" }}>{selected.summary}</p>
                      </>
                    )}
                  </div>
                  <div className="jrn-card">
                    <div className="jrn-card-head"><span>시간대별 체결 분포</span></div>
                    <div className="jrn-buckets">
                      {buckets.map((bucket) => (
                        <div key={bucket.hour} className="jrn-bucket-row">
                          <span>{bucket.hour}</span>
                          <div className="jrn-bucket-track">
                            <div className="jrn-bucket-fill" style={{ width: `${Math.round((bucket.count / maxBucket) * 100)}%` }} />
                          </div>
                          <span className="jrn-num">{bucket.count}건</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </section>

                <section className="jrn-table" aria-label="체결 복기 목록">
                  <div className="jrn-thead">
                    <span>시각</span>
                    <span>종목</span>
                    <span>구분</span>
                    <span className="jrn-num">체결가</span>
                    <span className="jrn-num">MFE</span>
                    <span className="jrn-num">MAE</span>
                    <span className="jrn-num">슬리피지</span>
                    <span>진단</span>
                  </div>
                  {filtered.map((item) => (
                    <button
                      key={`${item.orderNo}-${item.time}`}
                      type="button"
                      className="jrn-trow"
                      data-testid={`journal-row-${item.orderNo}`}
                      data-selected={selected?.orderNo === item.orderNo ? "true" : undefined}
                      onClick={() => setSelectedOrderNo(item.orderNo)}
                    >
                      <span className="jrn-num" style={{ textAlign: "left" }}>{item.time}</span>
                      <span><strong>{item.name}</strong></span>
                      <span className={item.side === "buy" ? "jrn-up" : "jrn-down"}>{item.side === "buy" ? "매수" : "매도"}</span>
                      <span className="jrn-num">{item.price.toLocaleString()}</span>
                      <span className="jrn-num jrn-up">{formatPct(item.mfePct)}</span>
                      <span className="jrn-num jrn-down">{formatPct(item.maePct)}</span>
                      <span className="jrn-num">{item.slippageTicks ?? "-"}</span>
                      <span>
                        <span className="jrn-tag" data-tone={DIAG_LABELS[item.diagnosis].tone}>
                          {DIAG_LABELS[item.diagnosis].label}
                        </span>
                      </span>
                    </button>
                  ))}
                </section>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
