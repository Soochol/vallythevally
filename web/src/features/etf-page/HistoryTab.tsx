import { useMemo, useState } from "react";
import { useEtfChanges, useEtfHistory } from "../../api/etf";
import type { EtfChangeKind } from "../../api/generated/EtfChangeKind";
import type { EtfChangePair } from "../../api/generated/EtfChangePair";
import { useSendSymbol } from "../pages/sendSymbol";
import { Badge, type BadgeTone } from "../ui/Badge";
import { Chip } from "../ui/Chip";
import { Segmented, type SegmentedOption } from "../ui/Segmented";
import { Failure, Loading, Notice } from "./EtfStates";
import { HelpTip } from "./HelpTip";
import {
  type DisplayedChangeRow,
  type HistoryKindFilter,
  filterChangeRows,
  formatQuantity,
  formatRealChange,
  formatScale,
  fullRangePair,
  pairOf,
  projectChangeRow,
} from "./etfModel";

const KIND_LABEL: Record<EtfChangeKind, string> = {
  added: "편입",
  removed: "편출",
  increased: "늘림",
  decreased: "줄임",
  unchanged: "유지",
};
const KIND_TONE: Record<EtfChangeKind, BadgeTone> = {
  added: "accent",
  removed: "warning",
  increased: "success",
  decreased: "danger",
  unchanged: "neutral",
};
const COUNT_KINDS = [
  ["added", "편입"],
  ["removed", "편출"],
  ["increased", "늘림"],
  ["decreased", "줄임"],
] as const;

type XrayOption = "on" | "off";

const XRAY_OPTIONS: readonly SegmentedOption<XrayOption>[] = [
  { value: "on", label: "보정 ON · 실질 증감" },
  { value: "off", label: "보정 OFF · 원본 수량" },
];

const KIND_FILTERS: readonly { value: HistoryKindFilter; label: string }[] = [
  { value: "all", label: "전체" },
  { value: "changed", label: "변동만" },
  { value: "buy", label: "편입·늘림" },
  { value: "sell", label: "줄임·편출" },
];

interface HistoryTabProps {
  code: string;
  pair: string | null;
  onPair: (after: string) => void;
  onOpenReverse: (stockCode: string) => void;
}

function Timeline({
  pairs,
  selected,
  fullRange,
  rangePair,
  onPair,
  onToggleFullRange,
}: {
  pairs: readonly EtfChangePair[];
  selected: EtfChangePair;
  fullRange: boolean;
  rangePair: { before: string; after: string } | null;
  onPair: (after: string) => void;
  onToggleFullRange: (next: boolean) => void;
}) {
  return (
    <section className="etf-card etf-card-wide" aria-label="날짜 쌍 타임라인">
      <div className="etf-card-head">
        <h3>수집한 날짜 쌍 · 최근순</h3>
        {rangePair !== null && (
          <Chip pressed={fullRange} onPressedChange={onToggleFullRange}>
            전체 구간 ({rangePair.before} → {rangePair.after})
          </Chip>
        )}
      </div>
      <ol className="etf-timeline">
        {pairs.map((pair) => {
          const buys = pair.added + pair.increased;
          const sells = pair.removed + pair.decreased;
          const total = buys + sells;
          const buyPct = total === 0 ? 0 : Math.round((buys / total) * 100);
          const sellPct = total === 0 ? 0 : 100 - buyPct;
          return (
            <li key={pair.after}>
              <button
                type="button"
                data-pair={pair.after}
                aria-pressed={!fullRange && pair === selected}
                aria-label={`${pair.before}부터 ${pair.after}까지`}
                onClick={() => onPair(pair.after)}
              >
                <span className="etf-pair-range">
                  {pair.before} → {pair.after}
                </span>
                <span className="etf-pair-counts">
                  {COUNT_KINDS.filter(([kind]) => pair[kind] > 0).map(([kind, label]) => (
                    <span key={kind} data-kind={kind}>
                      {label} {pair[kind]}
                    </span>
                  ))}
                </span>
                <span className="etf-pair-bar" aria-hidden="true">
                  <i className="etf-pair-bar-buy" style={{ width: `${buyPct}%` }} />
                  <i className="etf-pair-bar-sell" style={{ width: `${sellPct}%` }} />
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function DivergeBar({ item, maxAbs }: { item: DisplayedChangeRow; maxAbs: number }) {
  if (item.kind === "added") {
    return (
      <div className="etf-diverge-track" aria-hidden="true">
        <span className="etf-diverge-zero" />
        <span className="etf-diverge-bar" data-kind="added" style={{ left: "50%", width: "44%" }} />
      </div>
    );
  }
  if (item.kind === "removed") {
    return (
      <div className="etf-diverge-track" aria-hidden="true">
        <span className="etf-diverge-zero" />
        <span className="etf-diverge-bar" data-kind="removed" style={{ left: "6%", width: "44%" }} />
      </div>
    );
  }
  const value = item.change ?? 0;
  const pct = Math.min(48, (Math.abs(value) / maxAbs) * 48);
  const barWidth = Math.max(item.kind === "unchanged" ? 1 : 3, pct);
  const left = value >= 0 ? 50 : Math.max(0, 50 - barWidth);
  return (
    <div className="etf-diverge-track" aria-hidden="true">
      <span className="etf-diverge-zero" />
      <span
        className="etf-diverge-bar"
        data-kind={item.kind}
        style={{ left: `${left}%`, width: `${barWidth}%` }}
      />
    </div>
  );
}

function ChangeRow({
  item,
  maxAbs,
  xrayOn,
  onPick,
  onOpenReverse,
}: {
  item: DisplayedChangeRow;
  maxAbs: number;
  xrayOn: boolean;
  onPick: (row: DisplayedChangeRow["row"]) => void;
  onOpenReverse: (stockCode: string) => void;
}) {
  const { row, kind, change, isScaleNoise } = item;
  return (
    <tr
      data-code={row.code}
      data-kind={kind}
      data-noise={isScaleNoise ? "true" : undefined}
      onClick={() => onPick(row)}
    >
      <td>
        <span className="etf-stock-cell">
          <button type="button" className="etf-row-name" aria-label={`${row.name} 연동 차트로 보내기`}>
            {row.name}
          </button>
          <span className="etf-row-code">{row.code}</span>
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
      <td className="etf-num">{formatQuantity(row.beforeQuantity)}</td>
      <td className="etf-num">{formatQuantity(row.afterQuantity)}</td>
      <td className="etf-diverge-cell">
        <DivergeBar item={item} maxAbs={maxAbs} />
      </td>
      <td className="etf-num" data-direction={kind === "increased" ? "up" : kind === "decreased" ? "down" : "flat"}>
        {change === null ? "-" : formatRealChange(change)}
      </td>
      <td>
        <span className="etf-kind-cell">
          <Badge tone={KIND_TONE[kind]}>{KIND_LABEL[kind]}</Badge>
          {!xrayOn && isScaleNoise && <Badge tone="warning">CU 노이즈</Badge>}
        </span>
      </td>
    </tr>
  );
}

function Changes({
  code,
  pair,
  onOpenReverse,
}: {
  code: string;
  pair: { before: string; after: string };
  onOpenReverse: (stockCode: string) => void;
}) {
  const [xray, setXray] = useState<XrayOption>("on");
  const [kindFilter, setKindFilter] = useState<HistoryKindFilter>("all");
  const changes = useEtfChanges(code, pair);
  const send = useSendSymbol();

  const xrayOn = xray === "on";
  const projected = useMemo(
    () => (changes.data?.rows ?? []).map((row) => projectChangeRow(row, xrayOn)),
    [changes.data, xrayOn],
  );
  const visible = useMemo(() => filterChangeRows(projected, kindFilter), [projected, kindFilter]);
  const noiseCount = useMemo(() => projected.filter((item) => item.isScaleNoise).length, [projected]);
  const maxAbs = useMemo(
    () => Math.max(0.25, ...projected.map((item) => Math.abs(item.change ?? 0))),
    [projected],
  );

  if (changes.isPending) return <Loading label="증감을 불러오는 중입니다" />;
  if (changes.isError) return <Failure what="증감" retry={() => void changes.refetch()} />;
  const { commonScale } = changes.data;

  return (
    <section className="etf-card etf-card-wide" aria-label="종목별 증감">
      <div className="etf-xray-banner" data-xray={xray}>
        <div className="etf-xray-copy">
          <h4>
            CU당 수량 변화 · {pair.before} → {pair.after} · 공통 배율{" "}
            <span className="etf-scale">{formatScale(commonScale)}</span>
            <HelpTip
              label="실질 증감 설명"
              text="실질 증감 = (뒤 ÷ 앞) ÷ 공통 배율 − 1. ±1% 이내는 유지입니다. 공시된 바스켓의 차이이며 실제 체결 내역이 아닙니다."
            />
          </h4>
          <p>
            {xrayOn
              ? noiseCount > 0
                ? `공통 배율 보정으로 CU 크기 변동 착시가 있던 유지 종목 ${noiseCount}건을 걸러냈습니다.`
                : "공통 배율로 CU 크기 변동을 보정한 실질 수량 변화입니다."
              : noiseCount > 0
                ? `보정 해제 상태입니다. 유지 종목 ${noiseCount}건이 CU 배율 차이로 매수·매도처럼 표시됩니다.`
                : "보정 해제 상태입니다. 공시된 CU당 수량의 단순 증감률을 보여 줍니다."}
          </p>
        </div>
        <Segmented
          label="CU 보정 X-Ray"
          mode="pressed"
          size="sm"
          className="etf-xray-seg"
          options={XRAY_OPTIONS}
          value={xray}
          onChange={(next) => setXray(next)}
        />
      </div>
      <div className="etf-chip-row" role="group" aria-label="증감 구분 필터">
        {KIND_FILTERS.map((option) => (
          <Chip
            key={option.value}
            pressed={kindFilter === option.value}
            onPressedChange={() => setKindFilter(option.value)}
          >
            {option.label}
          </Chip>
        ))}
      </div>
      <div className="etf-table-wrap" data-scroll="">
        <table className="etf-table" aria-label="종목별 증감 표">
          <thead>
            <tr>
              <th scope="col">종목</th>
              <th scope="col" className="etf-num">앞 CU당 수량</th>
              <th scope="col" className="etf-num">뒤 CU당 수량</th>
              <th scope="col" className="etf-diverge-head">변화 막대</th>
              <th scope="col" className="etf-num">{xrayOn ? "실질 증감" : "원본 변화"}</th>
              <th scope="col">구분</th>
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 ? (
              <tr className="etf-empty-row">
                <td colSpan={6}>선택한 구분의 종목이 없습니다</td>
              </tr>
            ) : (
              visible.map((item) => (
                <ChangeRow
                  key={item.row.code}
                  item={item}
                  maxAbs={maxAbs}
                  xrayOn={xrayOn}
                  onPick={(picked) => send({ code: picked.code, name: picked.name })}
                  onOpenReverse={onOpenReverse}
                />
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function HistoryTab({ code, pair, onPair, onOpenReverse }: HistoryTabProps) {
  const [fullRangeCode, setFullRangeCode] = useState<string | null>(null);
  const history = useEtfHistory(code);
  if (history.isPending) return <Loading label="편입 변경을 불러오는 중입니다" />;
  if (history.isError) return <Failure what="편입 변경" retry={() => void history.refetch()} />;
  const { pairs, firstCollectedOn } = history.data;
  const selected = pairOf(pairs, pair);
  if (selected === null) {
    return (
      <Notice title="수집을 시작한 날부터 쌓입니다">
        {firstCollectedOn === null ? "아직 수집한 날짜가 없습니다" : `첫 수집일 ${firstCollectedOn}`}
      </Notice>
    );
  }
  const rangePair = fullRangePair(pairs);
  const fullRange = fullRangeCode === code && rangePair !== null;
  const activePair = fullRange && rangePair !== null ? rangePair : { before: selected.before, after: selected.after };

  return (
    <>
      <Timeline
        pairs={pairs}
        selected={selected}
        fullRange={fullRange}
        rangePair={rangePair}
        onPair={(after) => {
          setFullRangeCode(null);
          onPair(after);
        }}
        onToggleFullRange={(next) => setFullRangeCode(next ? code : null)}
      />
      <Changes
        key={`${code}:${activePair.before}:${activePair.after}`}
        code={code}
        pair={activePair}
        onOpenReverse={onOpenReverse}
      />
    </>
  );
}
