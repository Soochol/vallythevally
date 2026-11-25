import { Fragment, useState } from "react";
import { type EtfAccumulationWindow, useEtfAccumulation } from "../../api/etf";
import type { EtfAccumulationContributor } from "../../api/generated/EtfAccumulationContributor";
import type { EtfAccumulationRow } from "../../api/generated/EtfAccumulationRow";
import type { EtfAccumulationStyle } from "../../api/generated/EtfAccumulationStyle";
import { useSendSymbol } from "../pages/sendSymbol";
import { Badge } from "../ui/Badge";
import { Segmented, type SegmentedOption } from "../ui/Segmented";
import { Failure, Loading, Notice } from "./EtfStates";
import { HelpTip } from "./HelpTip";
import { MaLegend, MaMarks } from "./HoldingsTable";
import {
  formatAccumulationPeriod,
  formatMedianRealChange,
  formatPercent,
  formatRealChange,
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

const toWindow = (value: WindowOption): EtfAccumulationWindow => (value === "20" ? 20 : 5);

interface AccumulationTabProps {
  onOpenFund: (code: string) => void;
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
  return (
    <div className="etf-acc-contrib" role="region" aria-label={`${stockName} 매집 ETF 목록`}>
      <ul className="etf-acc-contrib-list">
        {contributors.map((contributor) => (
          <li key={contributor.fundCode} className="etf-acc-contrib-item">
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
            <span className="etf-acc-contrib-meta">
              <Badge tone={contributor.style === "active" ? "accent" : "neutral"}>
                {contributor.style === "active" ? "액티브" : "패시브"}
              </Badge>
              <Badge tone={contributor.kind === "added" ? "accent" : "success"}>
                {contributor.kind === "added" ? "편입" : "늘림"}
              </Badge>
              <span className="etf-num etf-acc-contrib-change" data-direction={contributor.kind === "increased" ? "up" : "flat"}>
                {contributor.realChange === null ? "-" : formatRealChange(contributor.realChange)}
              </span>
              <span className="etf-num etf-acc-contrib-weight">
                {contributor.afterWeightBps === null ? "-" : formatPercent(contributor.afterWeightBps)}
              </span>
            </span>
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
}: {
  rows: readonly EtfAccumulationRow[];
  expanded: string | null;
  onToggle: (code: string) => void;
  onOpenFund: (code: string) => void;
  onSendStock: (row: EtfAccumulationRow) => void;
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
                    </span>
                  </td>
                  <td className="etf-num">
                    <span className="etf-acc-count">{row.buyingEtfCount}개</span>
                    {row.addedEtfCount > 0 && <span className="etf-acc-added">신규 {row.addedEtfCount}</span>}
                  </td>
                  <td className="etf-num" data-direction={row.medianRealChange !== null && row.medianRealChange > 0 ? "up" : "flat"}>
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

export function AccumulationTab({ onOpenFund }: AccumulationTabProps) {
  const [windowOption, setWindowOption] = useState<WindowOption>("5");
  const [style, setStyle] = useState<EtfAccumulationStyle>("active");
  const [expanded, setExpanded] = useState<string | null>(null);
  const send = useSendSymbol();
  const query = useEtfAccumulation(toWindow(windowOption), style);

  const data = query.data ?? null;
  const period = data === null ? null : formatAccumulationPeriod(data.fromDate, data.toDate, data.collectedDays);
  const activeExpanded = data !== null && data.rows.some((row) => row.code === expanded) ? expanded : null;

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
        <section className="etf-card etf-card-wide" aria-label="동시 매집 종목">
          <h3>
            동시 매집 순위 · {query.data.rows.length}종목
            {query.data.maAsOf !== null && <span className="etf-acc-ma-date">이평선 기준일 {query.data.maAsOf}</span>}
          </h3>
          <AccumulationRows
            rows={query.data.rows}
            expanded={activeExpanded}
            onToggle={(code) => setExpanded((current) => (current === code ? null : code))}
            onOpenFund={onOpenFund}
            onSendStock={(row) => send({ code: row.code, name: row.name })}
          />
        </section>
      )}
    </>
  );
}
