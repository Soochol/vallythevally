import { useQueries } from "@tanstack/react-query";
import { useState } from "react";
import type { HeatmapFlowPoint } from "../../api/generated/HeatmapFlowPoint";
import type { HeatmapFlowSeries } from "../../api/generated/HeatmapFlowSeries";
import { heatmapFlowQuery } from "../../api/heatmapFlow";
import type { SymbolCode } from "../../api/generated/SymbolCode";
import type { Venue } from "../../api/generated/Venue";
import { formatKstClock } from "../../chart/time";
import { formatPercent } from "../../lib/format";
import { FLOW_FRAME, hourTicks, linePath, rateExtent, rateTicks, spreadLabels, timeExtent } from "./flowChart";
import { rateSide } from "./colors";
import type { HeatmapSection } from "./HeatmapPage";

const LABEL_GAP = 14;
const { width, height, left, right, top, bottom } = FLOW_FRAME;

interface Props {
  sections: readonly HeatmapSection[];
  names: ReadonlyMap<SymbolCode, string>;
  venue: Venue;
}

function flowGeometry(points: readonly HeatmapFlowPoint[]) {
  const rates = rateExtent(points.map((p) => p.rate));
  const times = timeExtent(points.map((p) => p.t));
  const x = (t: number) => left + ((t - times.min) / (times.max - times.min)) * (width - left - right);
  const y = (rate: number) => top + ((rates.max - rate) / (rates.max - rates.min)) * (height - top - bottom);
  return { x, y, rateTicks: rateTicks(rates), hourTicks: hourTicks(times) };
}

function namesOf(codes: readonly SymbolCode[], names: ReadonlyMap<SymbolCode, string>): string {
  return codes.map((code) => names.get(code) ?? code).join(", ");
}

interface GroupFlow {
  section: HeatmapSection;
  flow: HeatmapFlowSeries | undefined;
  failed: boolean;
  calculating: boolean;
}

export function HeatmapFlow({ sections, names, venue }: Props) {
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const results = useQueries({ queries: sections.map((section) => ({ ...heatmapFlowQuery(section.symbols, venue), enabled: section.symbols.length > 0 })) });
  const groups: GroupFlow[] = sections.flatMap((section, i) => {
    const query = results[i];
    return query ? [{ section, flow: query.data, failed: query.isError, calculating: query.isFetching && !query.data }] : [];
  });
  const drawn = groups.flatMap(({ section, flow }) => {
    const last = flow?.points[flow.points.length - 1];
    return flow && last && !hidden.has(section.key) ? [{ section, points: flow.points, last }] : [];
  });
  const geometry = drawn.length === 0 ? null : flowGeometry(drawn.flatMap(({ points }) => points));
  const toggle = (key: string) => setHidden((current) => {
    const next = new Set(current);
    if (!next.delete(key)) next.add(key);
    return next;
  });
  const labelYs = geometry ? spreadLabels(drawn.map(({ last }) => geometry.y(last.rate) + 4), LABEL_GAP, height - bottom) : [];
  return (
    <section className="hm-flow" aria-label="테마 흐름 비교">
      <header className="hm-flow-head">
        <h2>테마 흐름 비교</h2>
        <span>5분마다 · 테마의 거래대금 가중 평균 등락률(전일 종가 대비)</span>
      </header>
      <div className="hm-flow-legend" role="group" aria-label="테마 표시">
        {groups.map(({ section, flow }) => {
          const last = flow?.points[flow.points.length - 1];
          return (
            <button key={section.key} type="button" className="hm-flow-toggle" data-group={section.key} aria-pressed={!hidden.has(section.key)} onClick={() => toggle(section.key)}>
              <i style={{ background: section.color }} />
              {section.title}
              {last && <span className="hm-flow-now" data-side={rateSide(last.rate)}>{formatPercent(last.rate)}</span>}
            </button>
          );
        })}
      </div>
      {geometry === null ? (
        <p className="hm-flow-empty" role="status">{groups.some((group) => group.calculating) ? "흐름을 계산하는 중입니다" : "그릴 흐름이 없습니다. 테마를 켜거나 장이 열린 뒤에 다시 보세요"}</p>
      ) : (
        <svg className="hm-flow-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="테마별 장중 가중 평균 등락률">
          {geometry.rateTicks.map((rate) => (
            <g key={rate} className="hm-flow-grid" data-zero={rate === 0}>
              <line x1={left} x2={width - right} y1={geometry.y(rate)} y2={geometry.y(rate)} />
              <text x={left - 6} y={geometry.y(rate) + 4} textAnchor="end">{rate > 0 ? "+" : ""}{rate}%</text>
            </g>
          ))}
          {geometry.hourTicks.map((t) => (
            <text key={t} className="hm-flow-hour" x={geometry.x(t)} y={height - 8} textAnchor="middle">{formatKstClock(t)}</text>
          ))}
          {drawn.map(({ section, points, last }, i) => (
            <g key={section.key} className="hm-flow-series" data-group={section.key} style={{ color: section.color }}>
              <path className="hm-flow-line" data-group={section.key} d={linePath(points, geometry.x, geometry.y)} />
              <circle cx={geometry.x(last.t)} cy={geometry.y(last.rate)} r={3} />
              <text x={geometry.x(last.t) + 8} y={labelYs[i]}>{section.title} {formatPercent(last.rate)}</text>
            </g>
          ))}
        </svg>
      )}
      <div className="hm-flow-notes">
        {groups.flatMap(({ section, flow, failed }) => [
          failed && <p key={`${section.key}-error`} role="alert" data-group={section.key}>{section.title}: 흐름을 계산하지 못했습니다</p>,
          flow && flow.missing.length > 0 && <p key={`${section.key}-missing`} data-group={section.key}>{section.title}: 분봉을 받지 못해 평균에서 뺀 종목 {namesOf(flow.missing, names)}</p>,
          flow && flow.overLimit.length > 0 && <p key={`${section.key}-over`} data-group={section.key}>{section.title}: 한 번에 {flow.limit}종목까지만 계산해 뒤의 {flow.overLimit.length}종목({namesOf(flow.overLimit, names)})은 뺐습니다</p>,
        ])}
      </div>
    </section>
  );
}
