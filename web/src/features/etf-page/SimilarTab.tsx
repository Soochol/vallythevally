import { useEtfSimilar } from "../../api/etf";
import { Badge } from "../ui/Badge";
import { Failure, Loading, Notice } from "./EtfStates";
import { HelpTip } from "./HelpTip";
import { formatPercent } from "./etfModel";

const TOP_SIMILAR_LIMIT = 6;
const FULL_BPS = 10_000;

interface SimilarTabProps {
  code: string;
  fundName: string;
  onOpenFund: (code: string) => void;
  onComparePair: (codeA: string, codeB: string) => void;
}

export function SimilarTab({ code, fundName, onOpenFund, onComparePair }: SimilarTabProps) {
  const query = useEtfSimilar(code);
  if (query.isPending) return <Loading label="유사 ETF를 불러오는 중입니다" />;
  if (query.isError) return <Failure what="유사 ETF" retry={() => void query.refetch()} />;

  const items = query.data.items.slice(0, TOP_SIMILAR_LIMIT);
  if (items.length === 0) {
    return (
      <Notice title="유사한 ETF가 없습니다">
        공통 보유 종목이 있는 다른 ETF가 없습니다
      </Notice>
    );
  }

  return (
    <section className="etf-card etf-card-wide" aria-label="유사 ETF 목록">
      <h3>
        {fundName}와 구성이 비슷한 ETF · 상위 {items.length}개
        <HelpTip
          label="유사 ETF 설명"
          text="두 ETF가 함께 담은 종목마다 더 작은 비중을 합산한 겹침 비율이 높은 순으로 보여 줍니다. 차별화(Active Share)는 100%에서 겹침 비율을 뺀 값입니다."
        />
      </h3>
      <div className="etf-table-wrap">
        <table className="etf-table" aria-label="유사 ETF 표">
          <thead>
            <tr>
              <th scope="col">유사 ETF</th>
              <th scope="col">유형</th>
              <th scope="col" className="etf-num">겹침 비율</th>
              <th scope="col" className="etf-num">차별화(Active Share)</th>
              <th scope="col" className="etf-num">공통 종목</th>
              <th scope="col" className="etf-num">동작</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => {
              const activeShareBps = Math.max(0, FULL_BPS - item.overlapBps);
              return (
                <tr key={item.fund.code} data-code={item.fund.code} onClick={() => onOpenFund(item.fund.code)}>
                  <td>
                    <span className="etf-stock-cell">
                      <button type="button" className="etf-row-name" aria-label={`${item.fund.name} 구성 보기`}>
                        {item.fund.name}
                      </button>
                      <span className="etf-row-code">{item.fund.code}</span>
                      <span className="etf-similar-issuer">{item.fund.issuer}</span>
                    </span>
                  </td>
                  <td>
                    <Badge tone={item.fund.style === "active" ? "accent" : "neutral"}>
                      {item.fund.style === "active" ? "액티브" : "패시브"}
                    </Badge>
                  </td>
                  <td className="etf-num etf-weight-cell">
                    <span
                      className="etf-weight-bar"
                      style={{ "--weight": Math.min(1, item.overlapBps / FULL_BPS) } as React.CSSProperties}
                    />
                    <span className="etf-weight-value">{formatPercent(item.overlapBps)}</span>
                  </td>
                  <td className="etf-num">{formatPercent(activeShareBps)}</td>
                  <td className="etf-num">{item.commonCount}개</td>
                  <td className="etf-num">
                    <button
                      type="button"
                      className="btn btn-sm"
                      aria-label={`${item.fund.name} 나비 비교`}
                      onClick={(event) => {
                        event.stopPropagation();
                        onComparePair(code, item.fund.code);
                      }}
                    >
                      나비 비교
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
