import { useMemo, useState } from "react";
import { type EtfFlowWindow, useEtfFlows } from "../../api/etf";
import type { EtfFlowDirection } from "../../api/generated/EtfFlowDirection";
import type { EtfFlowRankRow } from "../../api/generated/EtfFlowRankRow";
import type { EtfFlowScope } from "../../api/generated/EtfFlowScope";
import type { EtfFlowSort } from "../../api/generated/EtfFlowSort";
import { Select } from "../menu/Select";
import { Badge } from "../ui/Badge";
import { Chip } from "../ui/Chip";
import { Segmented, type SegmentedOption } from "../ui/Segmented";
import { Failure, Loading, Notice } from "./EtfStates";
import { HelpTip } from "./HelpTip";
import { SharesNotConfiguredCard, SharesStatusBanner } from "./SharesStatusCard";
import {
  flowDirectionOf,
  formatAumWon,
  formatFlowWon,
  formatPremiumBps,
  formatSharesCount,
  formatSignedPercent,
} from "./etfModel";

type WindowOption = "1" | "5" | "20" | "60";

const WINDOW_CHOICES: readonly SegmentedOption<WindowOption>[] = [
  { value: "1", label: "1일" },
  { value: "5", label: "5일" },
  { value: "20", label: "20일" },
  { value: "60", label: "60일" },
];

const DIRECTION_CHOICES: readonly SegmentedOption<EtfFlowDirection>[] = [
  { value: "all", label: "유입·유출 대비" },
  { value: "inflow", label: "순유입 TOP" },
  { value: "outflow", label: "순유출 TOP" },
];

const SCOPE_CHOICES: readonly { value: EtfFlowScope; label: string }[] = [
  { value: "all", label: "KRX 전종목" },
  { value: "catalog", label: "분석 대상 ETF" },
  { value: "active", label: "액티브만" },
  { value: "passive", label: "패시브만" },
];

const SORT_OPTIONS: readonly { value: EtfFlowSort; label: string }[] = [
  { value: "amount", label: "순유입 금액순" },
  { value: "flow_ratio", label: "AUM 대비 유입률순" },
  { value: "share_pct", label: "좌수 증감률순" },
  { value: "aum", label: "순자산총액순" },
  { value: "streak", label: "연속 유출입일순" },
];

const toWindow = (value: WindowOption): EtfFlowWindow =>
  value === "1" ? 1 : value === "20" ? 20 : value === "60" ? 60 : 5;

function FlowSparkBars({ values }: { values: readonly number[] }) {
  const width = 76;
  const height = 22;
  const mid = height / 2;
  const maxAbs = Math.max(1, ...values.map((v) => Math.abs(v)));
  const barWidth = 5;
  const gap = 2.5;
  return (
    <svg className="etf-flow-spark" width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      <line x1={0} y1={mid} x2={width} y2={mid} className="etf-flow-spark-zero" />
      {values.map((value, idx) => {
        const x = idx * (barWidth + gap) + 1;
        const barHeight = Math.max(1.5, (Math.abs(value) / maxAbs) * (mid - 2));
        const y = value >= 0 ? mid - barHeight : mid;
        const tone = value > 0 ? "up" : value < 0 ? "down" : "flat";
        return (
          <rect
            key={idx}
            x={x}
            y={y}
            width={barWidth}
            height={barHeight}
            rx={1}
            className="etf-flow-spark-bar"
            data-tone={tone}
          />
        );
      })}
    </svg>
  );
}

function RankBarsColumn({
  title,
  totalWon,
  tone,
  rows,
  onOpenShares,
}: {
  title: string;
  totalWon: number;
  tone: "up" | "down";
  rows: readonly EtfFlowRankRow[];
  onOpenShares: (code: string) => void;
}) {
  const maxAbs = Math.max(1, ...rows.map((row) => Math.abs(row.netFlowWon)));
  return (
    <div className="etf-flow-rank-box">
      <div className="etf-flow-rank-head" data-direction={tone}>
        <span>{title}</span>
        <span>{formatFlowWon(totalWon, true)}</span>
      </div>
      {rows.length === 0 ? (
        <p className="etf-alpha-empty">해당 방향의 유출입 ETF가 없습니다</p>
      ) : (
        <div className="etf-flow-bars">
          {rows.map((row, idx) => {
            const pct = Math.max(6, Math.round((Math.abs(row.netFlowWon) / maxAbs) * 100));
            return (
              <button
                key={row.code}
                type="button"
                className="etf-flow-bar-row"
                data-code={row.code}
                onClick={() => onOpenShares(row.code)}
              >
                <span className="etf-flow-bar-rank">{idx + 1}</span>
                <span className="etf-flow-bar-info">
                  <span className="etf-flow-bar-name">{row.name}</span>
                  <span className="etf-flow-bar-meta">
                    <span>{row.code}</span>
                    <span>좌수 {formatSignedPercent(row.shareChangePct)}</span>
                  </span>
                </span>
                <span className="etf-flow-bar-track" aria-hidden="true">
                  <i data-direction={tone} style={{ width: `${pct}%` }} />
                </span>
                <span className="etf-flow-bar-val" data-direction={tone}>
                  {formatFlowWon(row.netFlowWon, true)}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

interface FlowTabProps {
  onOpenShares: (code: string) => void;
  onOpenAccumulation: () => void;
}

export function FlowTab({ onOpenShares, onOpenAccumulation }: FlowTabProps) {
  const [windowOption, setWindowOption] = useState<WindowOption>("5");
  const [direction, setDirection] = useState<EtfFlowDirection>("all");
  const [scope, setScope] = useState<EtfFlowScope>("all");
  const [sort, setSort] = useState<EtfFlowSort>("amount");
  const [streakOnly, setStreakOnly] = useState(false);
  const [largeAumOnly, setLargeAumOnly] = useState(false);

  const windowDays = toWindow(windowOption);
  const flows = useEtfFlows(windowDays, direction, scope, sort, 100);

  const filteredRows = useMemo(() => {
    const base = flows.data?.rows ?? [];
    return base.filter((row) => {
      if (streakOnly && Math.abs(row.streakDays) < 3) return false;
      if (largeAumOnly && row.aumWon < 100_000_000_000) return false;
      return true;
    });
  }, [flows.data, streakOnly, largeAumOnly]);

  const topInflows = useMemo(
    () =>
      filteredRows
        .filter((row) => row.netFlowWon > 0)
        .toSorted((a, b) => b.netFlowWon - a.netFlowWon)
        .slice(0, 6),
    [filteredRows],
  );

  const topOutflows = useMemo(
    () =>
      filteredRows
        .filter((row) => row.netFlowWon < 0)
        .toSorted((a, b) => a.netFlowWon - b.netFlowWon)
        .slice(0, 6),
    [filteredRows],
  );

  if (flows.isPending) return <Loading label="ETF 자금 흐름을 불러오는 중입니다" />;
  if (flows.isError) return <Failure what="자금 흐름" retry={() => void flows.refetch()} />;

  const { status, summary, fromDate, toDate } = flows.data;
  if (status.state === "not_configured") {
    return <SharesNotConfiguredCard onOpenAccumulation={onOpenAccumulation} />;
  }

  const grossWon = summary.inflowTotalWon + Math.abs(summary.outflowTotalWon);
  const inflowPct = grossWon > 0 ? Math.round((summary.inflowTotalWon / grossWon) * 100) : 50;
  const periodLabel =
    fromDate !== null && toDate !== null
      ? `${fromDate} ~ ${toDate} · KRX ${status.collectedDays}영업일 수집`
      : `KRX ${status.collectedDays}영업일 수집`;

  return (
    <>
      <SharesStatusBanner status={status} />

      <section className="etf-card etf-card-wide" aria-label="자금 흐름 필터">
        <div className="etf-acc-controls">
          <Segmented
            label="자금 집계 기간"
            mode="pressed"
            size="sm"
            className="etf-acc-seg"
            options={WINDOW_CHOICES}
            value={windowOption}
            onChange={(next) => setWindowOption(next)}
          />
          <span className="etf-controls-sep" aria-hidden="true" />
          <Segmented
            label="유출입 방향"
            mode="pressed"
            size="sm"
            className="etf-acc-seg"
            options={DIRECTION_CHOICES}
            value={direction}
            onChange={(next) => setDirection(next)}
          />
          <span className="etf-controls-sep" aria-hidden="true" />
          <Select
            label="자금 정렬"
            className="etf-flow-sort"
            value={sort}
            options={SORT_OPTIONS}
            onChange={(next) => setSort(next)}
          />
          <span className="etf-acc-period">{periodLabel}</span>
        </div>
        <div className="etf-chip-row" role="group" aria-label="자금 흐름 대상 필터">
          {SCOPE_CHOICES.map((option) => (
            <Chip
              key={option.value}
              pressed={scope === option.value}
              onPressedChange={() => setScope(option.value)}
            >
              {option.label}
            </Chip>
          ))}
          <Chip pressed={streakOnly} onPressedChange={setStreakOnly}>
            3일+ 연속 유출입
          </Chip>
          <Chip pressed={largeAumOnly} onPressedChange={setLargeAumOnly}>
            AUM 1,000억+
          </Chip>
        </div>
      </section>

      {status.collectedDays < 2 ? (
        <Notice title="상장좌수 자료가 2영업일 이상 쌓이면 자금 흐름이 집계됩니다">
          현재 수집일 {status.collectedDays}일
        </Notice>
      ) : (
        <>
          <dl className="etf-radar-kpis etf-card-wide" aria-label="자금 흐름 요약">
            <div className="etf-summary-cell">
              <dt>{windowDays}일 순자금 합계</dt>
              <dd className="etf-flow-kpi" data-direction={flowDirectionOf(summary.totalNetFlowWon)}>
                {formatFlowWon(summary.totalNetFlowWon, true)}
              </dd>
              <dd className="etf-summary-sub">
                <span>
                  유입 {formatFlowWon(summary.inflowTotalWon, false)} · 유출{" "}
                  {formatFlowWon(Math.abs(summary.outflowTotalWon), false)}
                </span>
                <span className="etf-pair-bar" aria-hidden="true">
                  <i className="etf-pair-bar-buy" style={{ width: `${inflowPct}%` }} />
                  <i className="etf-pair-bar-sell" style={{ width: `${100 - inflowPct}%` }} />
                </span>
              </dd>
            </div>
            <div className="etf-summary-cell">
              <dt>설정 · 환매 확산도</dt>
              <dd>
                <span className="etf-flow-up">{summary.inflowEtfCount}</span> /{" "}
                <span className="etf-flow-down">{summary.outflowEtfCount}</span>
              </dd>
              <dd className="etf-summary-sub">
                전체 {summary.totalEtfCount}개 중 유입 비중 {inflowPct}%
              </dd>
            </div>
            <div className="etf-summary-cell">
              <dt>최대 자금 유입</dt>
              <dd>
                {summary.topInflowCode !== null && summary.topInflowName !== null ? (
                  <button
                    type="button"
                    className="etf-flow-kpi-link"
                    onClick={() => onOpenShares(summary.topInflowCode!)}
                  >
                    {summary.topInflowName}
                  </button>
                ) : (
                  "-"
                )}
              </dd>
              {summary.topInflowWon !== null && (
                <dd className="etf-summary-sub">
                  <span className="etf-flow-up">{formatFlowWon(summary.topInflowWon, true)}</span>
                </dd>
              )}
            </div>
            <div className="etf-summary-cell">
              <dt>최대 자금 유출</dt>
              <dd>
                {summary.topOutflowCode !== null && summary.topOutflowName !== null ? (
                  <button
                    type="button"
                    className="etf-flow-kpi-link"
                    onClick={() => onOpenShares(summary.topOutflowCode!)}
                  >
                    {summary.topOutflowName}
                  </button>
                ) : (
                  "-"
                )}
              </dd>
              {summary.topOutflowWon !== null && (
                <dd className="etf-summary-sub">
                  <span className="etf-flow-down">{formatFlowWon(summary.topOutflowWon, true)}</span>
                </dd>
              )}
            </div>
          </dl>

          <section className="etf-card etf-card-wide" aria-label="설정·환매 상위 비교">
            <div className="etf-card-head">
              <h3>
                {windowDays}일 설정·환매 TOP
                <HelpTip
                  label="추정 순자금 유출입 설명"
                  text="일별 상장좌수 증감(ΔLIST_SHRS) × 당일 NAV를 기간 합산한 추정 순자금 흐름입니다. 액면분할·병합일은 0으로 보정합니다."
                />
              </h3>
            </div>
            <div className="etf-flow-split-grid">
              {direction !== "outflow" && (
                <RankBarsColumn
                  title="▲ 자금 순유입 TOP 6"
                  totalWon={summary.inflowTotalWon}
                  tone="up"
                  rows={topInflows}
                  onOpenShares={onOpenShares}
                />
              )}
              {direction !== "inflow" && (
                <RankBarsColumn
                  title="▼ 자금 순유출 TOP 6"
                  totalWon={summary.outflowTotalWon}
                  tone="down"
                  rows={topOutflows}
                  onOpenShares={onOpenShares}
                />
              )}
            </div>
          </section>

          <section className="etf-card etf-card-wide" aria-label="자금 유출입 순위">
            <div className="etf-card-head">
              <h3>자금 유출입 상세 순위 ({filteredRows.length}개)</h3>
            </div>
            <div className="etf-table-wrap" data-scroll="">
              <table className="etf-table" aria-label="자금 유출입 랭킹 표">
                <thead>
                  <tr>
                    <th scope="col">#</th>
                    <th scope="col">ETF</th>
                    <th scope="col" className="etf-num">{windowDays}일 추정 순유입</th>
                    <th scope="col" className="etf-num">좌수 증감</th>
                    <th scope="col" className="etf-num">AUM 대비</th>
                    <th scope="col" className="etf-num">순자산총액</th>
                    <th scope="col" className="etf-num">연속 흐름</th>
                    <th scope="col">최근 10일</th>
                    <th scope="col" className="etf-num">괴리율</th>
                    <th scope="col" className="etf-num">차트</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredRows.length === 0 ? (
                    <tr className="etf-empty-row">
                      <td colSpan={10}>선택한 조건에 맞는 ETF가 없습니다</td>
                    </tr>
                  ) : (
                    filteredRows.map((row, idx) => {
                      const flowDir = flowDirectionOf(row.netFlowWon);
                      return (
                        <tr
                          key={row.code}
                          data-code={row.code}
                          onClick={() => onOpenShares(row.code)}
                        >
                          <td className="etf-rank">{idx + 1}</td>
                          <td>
                            <span className="etf-stock-cell">
                              <span className="etf-row-name">{row.name}</span>
                              <span className="etf-row-code">{row.code}</span>
                              {row.style !== null ? (
                                <Badge tone={row.style === "active" ? "accent" : "neutral"}>
                                  {row.style === "active" ? "액티브" : "패시브"}
                                </Badge>
                              ) : (
                                <Badge tone="neutral">KRX</Badge>
                              )}
                            </span>
                          </td>
                          <td className="etf-num" data-direction={flowDir}>
                            {formatFlowWon(row.netFlowWon, true)}
                          </td>
                          <td className="etf-num" data-direction={flowDirectionOf(row.shareChange)}>
                            {formatSharesCount(row.shareChange, true)}{" "}
                            <span className="etf-muted">({formatSignedPercent(row.shareChangePct)})</span>
                          </td>
                          <td className="etf-num" data-direction={flowDir}>
                            {formatSignedPercent(row.flowToAumPct)}
                          </td>
                          <td className="etf-num">{formatAumWon(row.aumWon)}</td>
                          <td className="etf-num">
                            {row.streakDays >= 2 ? (
                              <Badge tone="success">▲ {row.streakDays}일</Badge>
                            ) : row.streakDays <= -2 ? (
                              <Badge tone="danger">▼ {Math.abs(row.streakDays)}일</Badge>
                            ) : (
                              <span className="etf-muted">-</span>
                            )}
                          </td>
                          <td>
                            <FlowSparkBars values={row.sparklineFlow} />
                          </td>
                          <td className="etf-num etf-muted">{formatPremiumBps(row.premiumBps)}</td>
                          <td className="etf-num">
                            <button
                              type="button"
                              className="etf-mini-btn"
                              aria-label={`${row.name} 좌수 차트`}
                              onClick={(event) => {
                                event.stopPropagation();
                                onOpenShares(row.code);
                              }}
                            >
                              좌수 차트
                            </button>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </>
  );
}
