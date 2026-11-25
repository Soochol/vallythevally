import { Fragment, type KeyboardEvent, useMemo, useRef, useState } from "react";
import { type EtfAccumulationWindow, useEtfAccumulation } from "../../api/etf";
import type { EtfAccumulationContributor } from "../../api/generated/EtfAccumulationContributor";
import type { EtfAccumulationRow } from "../../api/generated/EtfAccumulationRow";
import type { EtfAccumulationStyle } from "../../api/generated/EtfAccumulationStyle";
import { useElementSize } from "../heatmap-page/useElementSize";
import { useSendSymbol } from "../pages/sendSymbol";
import { Badge } from "../ui/Badge";
import { Chip } from "../ui/Chip";
import { Segmented, type SegmentedOption } from "../ui/Segmented";
import { Failure, Loading, Notice } from "./EtfStates";
import { HelpTip } from "./HelpTip";
import { MaLegend, MaMarks } from "./HoldingsTable";
import {
  type RadarChipFilter,
  filterAccumulationRows,
  formatAccumulationPeriod,
  formatMedianRealChange,
  formatPercent,
  formatRealChange,
  maAlignedCount,
  radarSummary,
} from "./etfModel";

type WindowOption = "5" | "20";

const WINDOW_CHOICES: readonly SegmentedOption<WindowOption>[] = [
  { value: "5", label: "5일" },
  { value: "20", label: "20일" },
];

const STYLE_CHOICES: readonly SegmentedOption<EtfAccumulationStyle>[] = [
  { value: "active", label: "액티브만" },
  { value: "all", label: "전체" },
];

const CHIP_CHOICES: readonly { value: RadarChipFilter; label: string }[] = [
  { value: "all", label: "전체" },
  { value: "added", label: "신규 편입 포함" },
  { value: "aligned", label: "이평선 정배열 3▲" },
  { value: "multi", label: "3개+ 동시 매집" },
];

const toWindow = (value: WindowOption): EtfAccumulationWindow => (value === "20" ? 20 : 5);

const RADAR_DEFAULT_W = 720;
const RADAR_H = 216;
const RADAR_LEFT = 48;
const RADAR_RIGHT_PAD = 32;
const RADAR_TOP = 24;
const RADAR_BOTTOM = 182;

interface AccumulationTabProps {
  onOpenFund: (code: string) => void;
  onOpenReverse: (code: string) => void;
}

function RadarKpiStrip({ rows }: { rows: readonly EtfAccumulationRow[] }) {
  const summary = useMemo(() => radarSummary(rows), [rows]);
  const alignedPct = summary.total === 0 ? 0 : Math.round((summary.alignedStocks / summary.total) * 100);
  return (
    <dl className="etf-radar-kpis etf-card-wide" aria-label="동시 매집 요약">
      <div className="etf-summary-cell">
        <dt>동시 매집 종목</dt>
        <dd>{summary.total}종목</dd>
      </div>
      <div className="etf-summary-cell">
        <dt>신규 편입 발생</dt>
        <dd>{summary.addedStocks}종목</dd>
      </div>
      <div className="etf-summary-cell">
        <dt>최다 컨센서스</dt>
        <dd>{summary.topRow ? summary.topRow.name : "-"}</dd>
        {summary.topRow && <dd className="etf-summary-sub">{summary.topRow.buyingEtfCount}개 ETF 동시 매수</dd>}
      </div>
      <div className="etf-summary-cell">
        <dt>이평선 정배열 일치</dt>
        <dd>{summary.alignedStocks}종목</dd>
        <dd className="etf-summary-sub">3▲ 정배열 {alignedPct}%</dd>
      </div>
    </dl>
  );
}

function ConvictionRadar({
  rows,
  expanded,
  onToggle,
}: {
  rows: readonly EtfAccumulationRow[];
  expanded: string | null;
  onToggle: (code: string) => void;
}) {
  const stage = useRef<HTMLDivElement>(null);
  const { w: measuredW } = useElementSize(stage);
  const svgW = Math.max(320, measuredW > 0 ? Math.round(measuredW) : RADAR_DEFAULT_W);
  const radarRight = svgW - RADAR_RIGHT_PAD;
  const rawMax = Math.max(
    0.35,
    ...rows.map((row) => (row.medianRealChange === null ? 0 : Math.max(0, row.medianRealChange))),
  );
  const maxChange = Math.max(0.4, Math.ceil(rawMax * 10) / 10);
  const maxCount = Math.max(4, ...rows.map((row) => row.buyingEtfCount));
  const plotW = Math.max(160, radarRight - RADAR_LEFT);
  const plotH = RADAR_BOTTOM - RADAR_TOP;
  const xFor = (change: number | null) =>
    change === null
      ? RADAR_LEFT + plotW * 0.92
      : RADAR_LEFT + (Math.min(maxChange, Math.max(0, change)) / maxChange) * (plotW * 0.82);
  const yFor = (count: number) => RADAR_BOTTOM - ((count - 0.5) / maxCount) * plotH;

  const zoneX = xFor(0.15);
  const zoneY = RADAR_TOP;
  const zoneH = Math.max(24, yFor(2.6) - RADAR_TOP);
  const xTicks = [0, 0.15, maxChange];
  const yTicks = Array.from({ length: Math.min(5, maxCount) }, (_, idx) =>
    Math.max(1, Math.round(((idx + 1) * maxCount) / Math.min(5, maxCount))),
  );
  const uniqueYTicks = [...new Set(yTicks)];

  const handleKey = (event: KeyboardEvent<SVGGElement>, code: string) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onToggle(code);
    }
  };

  return (
    <section className="etf-card etf-card-wide" aria-label="컨빅션 버블 레이더">
      <div className="etf-card-head">
        <h3>컨빅션 버블 레이더</h3>
        <div className="etf-radar-legend">
          <span data-tone="added">신규 편입 포함</span>
          <span data-tone="aligned">이평 정배열 3▲</span>
          <span data-tone="normal">일반 매집</span>
        </div>
      </div>
      <div ref={stage} className="etf-radar-stage">
        <svg
          className="etf-radar-svg"
          width={svgW}
          height={RADAR_H}
          viewBox={`0 0 ${svgW} ${RADAR_H}`}
          role="img"
          aria-label={`컨빅션 버블 레이더 ${rows.length}종목`}
        >
          <rect
            x={zoneX}
            y={zoneY}
            width={Math.max(40, radarRight - zoneX)}
            height={zoneH}
            rx={6}
            className="etf-radar-zone"
          />
          <text x={radarRight - 8} y={zoneY + 14} textAnchor="end" className="etf-radar-zone-label">
            고확신 구간 (3개+ · +15%↑)
          </text>
          {uniqueYTicks.map((tick) => (
            <g key={tick}>
              <line x1={RADAR_LEFT} x2={radarRight} y1={yFor(tick)} y2={yFor(tick)} className="etf-curve-grid" />
              <text x={RADAR_LEFT - 8} y={yFor(tick) + 4} textAnchor="end" className="etf-curve-axis">
                {tick}개
              </text>
            </g>
          ))}
          {xTicks.map((tick) => (
            <g key={tick}>
              <line x1={xFor(tick)} x2={xFor(tick)} y1={RADAR_TOP} y2={RADAR_BOTTOM} className="etf-curve-grid" />
              <text x={xFor(tick)} y={RADAR_BOTTOM + 16} textAnchor="middle" className="etf-curve-axis">
                +{Math.round(tick * 100)}%
              </text>
            </g>
          ))}
          <text x={xFor(null)} y={RADAR_BOTTOM + 16} textAnchor="middle" className="etf-curve-axis">
            신규편입
          </text>
          {rows.map((row, idx) => {
            const cx = xFor(row.medianRealChange);
            const jitter = ((idx % 3) - 1) * 5;
            const cy = Math.min(RADAR_BOTTOM - 12, Math.max(RADAR_TOP + 12, yFor(row.buyingEtfCount) + jitter));
            const r = Math.min(18, 7 + row.buyingEtfCount * 2.5);
            const tone =
              row.addedEtfCount > 0 ? "added" : maAlignedCount(row.ma) === 3 ? "aligned" : "normal";
            const selected = expanded === row.code;
            return (
              <g
                key={row.code}
                role="button"
                tabIndex={0}
                className="etf-radar-bubble"
                data-bubble-code={row.code}
                data-tone={tone}
                data-selected={selected ? "true" : undefined}
                aria-pressed={selected}
                aria-label={`${row.name} 매수 ETF ${row.buyingEtfCount}개`}
                onClick={() => onToggle(row.code)}
                onKeyDown={(event) => handleKey(event, row.code)}
              >
                <circle cx={cx} cy={cy} r={r} className="etf-radar-circle" />
                <text
                  x={cx}
                  y={cy - r - 4}
                  textAnchor="middle"
                  className="etf-radar-label"
                >
                  {row.name}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
    </section>
  );
}

function ContributorsPanel({
  stockName,
  contributors,
  onOpenFund,
}: {
  stockName: string;
  contributors: readonly EtfAccumulationContributor[];
  onOpenFund: (code: string) => void;
}) {
  const maxWeight = Math.max(100, ...contributors.map((item) => item.afterWeightBps ?? 0));
  return (
    <div className="etf-acc-contrib" role="region" aria-label={`${stockName} 매집 ETF 목록`}>
      <ul className="etf-acc-contrib-list">
        {contributors.map((contributor) => (
          <li key={contributor.fundCode} className="etf-acc-contrib-item">
            <div className="etf-acc-contrib-top">
              <button
                type="button"
                className="etf-acc-fund-link"
                data-fund-code={contributor.fundCode}
                aria-label={`${contributor.fundName} 구성 보기`}
                onClick={() => onOpenFund(contributor.fundCode)}
              >
                <span className="etf-acc-fund-name">{contributor.fundName}</span>
                <span className="etf-row-code">{contributor.fundCode}</span>
              </button>
              <Badge tone={contributor.kind === "added" ? "accent" : "success"}>
                {contributor.kind === "added" ? "편입" : "늘림"}
              </Badge>
            </div>
            <div className="etf-acc-contrib-meta">
              <Badge tone={contributor.style === "active" ? "accent" : "neutral"}>
                {contributor.style === "active" ? "액티브" : "패시브"}
              </Badge>
              <span
                className="etf-num etf-acc-contrib-change"
                data-direction={contributor.kind === "increased" ? "up" : "flat"}
              >
                {contributor.realChange === null ? "-" : formatRealChange(contributor.realChange)}
              </span>
              <span className="etf-num etf-acc-contrib-weight">
                {contributor.afterWeightBps === null ? "-" : formatPercent(contributor.afterWeightBps)}
              </span>
            </div>
            <div className="etf-acc-contrib-bar" aria-hidden="true">
              <i
                style={{
                  width: `${Math.min(100, Math.round(((contributor.afterWeightBps ?? 0) / maxWeight) * 100))}%`,
                }}
              />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function AccumulationRows({
  rows,
  expanded,
  onToggle,
  onOpenFund,
  onSendStock,
  onOpenReverse,
}: {
  rows: readonly EtfAccumulationRow[];
  expanded: string | null;
  onToggle: (code: string) => void;
  onOpenFund: (code: string) => void;
  onSendStock: (row: EtfAccumulationRow) => void;
  onOpenReverse: (code: string) => void;
}) {
  return (
    <div className="etf-table-wrap" data-scroll="">
      <MaLegend />
      <table className="etf-table" aria-label="동시 매집 종목 표">
        <thead>
          <tr>
            <th scope="col" className="etf-num">순위</th>
            <th scope="col">종목</th>
            <th scope="col" className="etf-num">매수 ETF</th>
            <th scope="col" className="etf-num">중앙 실질 증감</th>
            <th scope="col" className="etf-ma-head">이평선 20·60·120</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => {
            const isOpen = expanded === row.code;
            return (
              <Fragment key={row.code}>
                <tr
                  data-code={row.code}
                  data-expanded={isOpen ? "true" : "false"}
                  aria-expanded={isOpen}
                  onClick={() => onToggle(row.code)}
                >
                  <td className="etf-num etf-rank">{index + 1}</td>
                  <td>
                    <span className="etf-acc-stock-cell">
                      <button
                        type="button"
                        className="etf-row-name"
                        aria-expanded={isOpen}
                        aria-label={`${row.name} 매집 ETF 펼치기`}
                      >
                        {row.name}
                      </button>
                      <span className="etf-row-code">{row.code}</span>
                      <button
                        type="button"
                        className="btn btn-sm etf-acc-chart-btn"
                        aria-label={`${row.name} 연동 차트로 보내기`}
                        onClick={(event) => {
                          event.stopPropagation();
                          onSendStock(row);
                        }}
                      >
                        차트
                      </button>
                      <button
                        type="button"
                        className="etf-mini-btn"
                        aria-label={`${row.name} 역추적`}
                        onClick={(event) => {
                          event.stopPropagation();
                          onOpenReverse(row.code);
                        }}
                      >
                        역추적
                      </button>
                    </span>
                  </td>
                  <td className="etf-num">
                    <span className="etf-acc-count">{row.buyingEtfCount}개</span>
                    {row.addedEtfCount > 0 && <span className="etf-acc-added">신규 {row.addedEtfCount}</span>}
                  </td>
                  <td
                    className="etf-num"
                    data-direction={row.medianRealChange !== null && row.medianRealChange > 0 ? "up" : "flat"}
                  >
                    {formatMedianRealChange(row.medianRealChange)}
                  </td>
                  <td className="etf-ma-cell">
                    <MaMarks ma={row.ma} />
                  </td>
                </tr>
                {isOpen && (
                  <tr className="etf-acc-detail-row" data-detail-for={row.code}>
                    <td colSpan={5}>
                      <ContributorsPanel
                        stockName={row.name}
                        contributors={row.contributors}
                        onOpenFund={onOpenFund}
                      />
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function AccumulationTab({ onOpenFund, onOpenReverse }: AccumulationTabProps) {
  const [windowOption, setWindowOption] = useState<WindowOption>("5");
  const [style, setStyle] = useState<EtfAccumulationStyle>("active");
  const [chip, setChip] = useState<RadarChipFilter>("all");
  const [expanded, setExpanded] = useState<string | null>(null);
  const send = useSendSymbol();
  const query = useEtfAccumulation(toWindow(windowOption), style);

  const data = query.data ?? null;
  const period = data === null ? null : formatAccumulationPeriod(data.fromDate, data.toDate, data.collectedDays);
  const filteredRows = useMemo(() => (data === null ? [] : filterAccumulationRows(data.rows, chip)), [data, chip]);
  const activeExpanded = filteredRows.some((row) => row.code === expanded) ? expanded : null;

  return (
    <>
      <section className="etf-card etf-card-wide" aria-label="동시 매집 조건">
        <div className="etf-acc-controls">
          <Segmented
            label="집계 기간"
            mode="pressed"
            size="sm"
            className="etf-acc-seg"
            options={WINDOW_CHOICES}
            value={windowOption}
            onChange={(next) => {
              setWindowOption(next);
              setExpanded(null);
            }}
          />
          <Segmented
            label="대상 ETF"
            mode="pressed"
            size="sm"
            className="etf-acc-seg"
            options={STYLE_CHOICES}
            value={style}
            onChange={(next) => {
              setStyle(next);
              setExpanded(null);
            }}
          />
          <span className="etf-acc-period" role="status">
            {period ?? (data === null ? "" : `수집일 ${data.collectedDays}일`)}
          </span>
          <HelpTip
            label="동시 매집 설명"
            text="공통 배율로 CU 크기 변화를 제거한 뒤 기간 내 신규 편입하거나 수량을 1% 넘게 늘린 ETF 수를 종목별로 집계합니다. 공시된 바스켓의 차이이며 실제 체결 내역이 아닙니다."
          />
        </div>
        {data !== null && data.rows.length > 0 && (
          <div className="etf-chip-row" role="group" aria-label="동시 매집 필터">
            {CHIP_CHOICES.map((option) => (
              <Chip
                key={option.value}
                pressed={chip === option.value}
                onPressedChange={() => {
                  setChip(option.value);
                  setExpanded(null);
                }}
              >
                {option.label}
              </Chip>
            ))}
          </div>
        )}
      </section>
      {query.isPending ? (
        <Loading label="동시 매집 종목을 불러오는 중입니다" />
      ) : query.isError ? (
        <Failure what="동시 매집" retry={() => void query.refetch()} />
      ) : query.data.fromDate === null || query.data.toDate === null ? (
        <Notice title="수집일이 2일 이상 쌓이면 집계됩니다">
          {query.data.collectedDays === 0 ? "아직 수집한 날짜가 없습니다" : `현재 수집일 ${query.data.collectedDays}일`}
        </Notice>
      ) : query.data.rows.length === 0 ? (
        <Notice title="이 기간에 동시 매집 종목이 없습니다">기간이나 대상 ETF 조건을 바꿔 보세요</Notice>
      ) : (
        <>
          <RadarKpiStrip rows={query.data.rows} />
          {filteredRows.length > 0 && (
            <ConvictionRadar
              rows={filteredRows}
              expanded={activeExpanded}
              onToggle={(code) => setExpanded((current) => (current === code ? null : code))}
            />
          )}
          <section className="etf-card etf-card-wide" aria-label="동시 매집 종목">
            <h3>
              동시 매집 순위 · {filteredRows.length}종목
              {query.data.maAsOf !== null && <span className="etf-acc-ma-date">이평선 기준일 {query.data.maAsOf}</span>}
            </h3>
            {filteredRows.length === 0 ? (
              <Notice title="선택한 조건에 맞는 종목이 없습니다" wide={false}>
                다른 필터를 선택해 보세요
              </Notice>
            ) : (
              <AccumulationRows
                rows={filteredRows}
                expanded={activeExpanded}
                onToggle={(code) => setExpanded((current) => (current === code ? null : code))}
                onOpenFund={onOpenFund}
                onSendStock={(row) => send({ code: row.code, name: row.name })}
                onOpenReverse={onOpenReverse}
              />
            )}
          </section>
        </>
      )}
    </>
  );
}
