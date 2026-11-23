import { useEtfChanges, useEtfHistory } from "../../api/etf";
import type { EtfChangeKind } from "../../api/generated/EtfChangeKind";
import type { EtfChangePair } from "../../api/generated/EtfChangePair";
import type { EtfChangeRow } from "../../api/generated/EtfChangeRow";
import { useSendSymbol } from "../pages/sendSymbol";
import { Badge, type BadgeTone } from "../ui/Badge";
import { Failure, Loading, Notice } from "./EtfStates";
import { HelpTip } from "./HelpTip";
import { formatQuantity, formatRealChange, formatScale, pairOf } from "./etfModel";

const KIND_LABEL: Record<EtfChangeKind, string> = { added: "편입", removed: "편출", increased: "늘림", decreased: "줄임", unchanged: "유지" };
const KIND_TONE: Record<EtfChangeKind, BadgeTone> = { added: "accent", removed: "warning", increased: "success", decreased: "danger", unchanged: "neutral" };
const COUNT_KINDS = [["added", "편입"], ["removed", "편출"], ["increased", "늘림"], ["decreased", "줄임"]] as const;

interface HistoryTabProps {
  code: string;
  pair: string | null;
  onPair: (after: string) => void;
}

function Timeline({ pairs, selected, onPair }: { pairs: readonly EtfChangePair[]; selected: EtfChangePair; onPair: (after: string) => void }) {
  return (
    <section className="etf-card etf-card-wide" aria-label="날짜 쌍 타임라인">
      <h3>수집한 날짜 쌍 · 최근순</h3>
      <ol className="etf-timeline">
        {pairs.map((pair) => (
          <li key={pair.after}>
            <button type="button" data-pair={pair.after} aria-pressed={pair === selected} aria-label={`${pair.before}부터 ${pair.after}까지`} onClick={() => onPair(pair.after)}>
              <span className="etf-pair-range">{pair.before} → {pair.after}</span>
              <span className="etf-pair-counts">
                {COUNT_KINDS.filter(([kind]) => pair[kind] > 0).map(([kind, label]) => <span key={kind} data-kind={kind}>{label} {pair[kind]}</span>)}
              </span>
            </button>
          </li>
        ))}
      </ol>
    </section>
  );
}

function ChangeRow({ row, onPick }: { row: EtfChangeRow; onPick: (row: EtfChangeRow) => void }) {
  return (
    <tr data-code={row.code} data-kind={row.kind} onClick={() => onPick(row)}>
      <td>
        <button type="button" className="etf-row-name" aria-label={`${row.name} 연동 차트로 보내기`}>{row.name}</button>
        <span className="etf-row-code">{row.code}</span>
      </td>
      <td className="etf-num">{formatQuantity(row.beforeQuantity)}</td>
      <td className="etf-num">{formatQuantity(row.afterQuantity)}</td>
      <td className="etf-num" data-direction={row.kind === "increased" ? "up" : row.kind === "decreased" ? "down" : "flat"}>{row.realChange === null ? "-" : formatRealChange(row.realChange)}</td>
      <td><Badge tone={KIND_TONE[row.kind]}>{KIND_LABEL[row.kind]}</Badge></td>
    </tr>
  );
}

function Changes({ code, pair }: { code: string; pair: EtfChangePair }) {
  const changes = useEtfChanges(code, pair);
  const send = useSendSymbol();
  if (changes.isPending) return <Loading label="증감을 불러오는 중입니다" />;
  if (changes.isError) return <Failure what="증감" retry={() => void changes.refetch()} />;
  const { rows, commonScale } = changes.data;
  return (
    <section className="etf-card etf-card-wide" aria-label="종목별 증감">
      <h3>
        CU당 수량 변화 · {pair.before} → {pair.after} · 공통 배율 <span className="etf-scale">{formatScale(commonScale)}</span>
        <HelpTip label="실질 증감 설명" text="실질 증감 = (뒤 ÷ 앞) ÷ 공통 배율 − 1. ±1% 이내는 유지입니다. 공시된 바스켓의 차이이며 실제 체결 내역이 아닙니다." />
      </h3>
      <div className="etf-table-wrap" data-scroll="">
        <table className="etf-table" aria-label="종목별 증감 표">
          <thead>
            <tr>
              <th scope="col">종목</th>
              <th scope="col" className="etf-num">앞 CU당 수량</th>
              <th scope="col" className="etf-num">뒤 CU당 수량</th>
              <th scope="col" className="etf-num">실질 증감</th>
              <th scope="col">구분</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <ChangeRow key={row.code} row={row} onPick={(picked) => send({ code: picked.code, name: picked.name })} />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function HistoryTab({ code, pair, onPair }: HistoryTabProps) {
  const history = useEtfHistory(code);
  if (history.isPending) return <Loading label="편입 변경을 불러오는 중입니다" />;
  if (history.isError) return <Failure what="편입 변경" retry={() => void history.refetch()} />;
  const { pairs, firstCollectedOn } = history.data;
  const selected = pairOf(pairs, pair);
  if (selected === null) {
    return <Notice title="수집을 시작한 날부터 쌓입니다">{firstCollectedOn === null ? "아직 수집한 날짜가 없습니다" : `첫 수집일 ${firstCollectedOn}`}</Notice>;
  }
  return (
    <>
      <Timeline pairs={pairs} selected={selected} onPair={onPair} />
      <Changes code={code} pair={selected} />
    </>
  );
}
