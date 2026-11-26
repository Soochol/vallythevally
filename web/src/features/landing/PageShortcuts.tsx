import { Link } from "react-router";
import { SHORTCUT_PAGES } from "../page-rail/pages";
import "./pageShortcuts.css";

const SUMMARIES: Record<(typeof SHORTCUT_PAGES)[number]["id"], string> = {
  market: "지수와 수급, 업종, 거래대금을 한 화면에서 봅니다.",
  heatmap: "내가 고른 테마를 등락률 타일 지도로 봅니다.",
  etf: "ETF가 담은 종목과 겹침을 살펴봅니다.",
  replay: "지나간 날의 호가·체결·수급 흐름을 재생하며 복기합니다.",
};

export function PageShortcuts() {
  return (
    <section aria-label="페이지 바로가기" className="landing-shortcuts-wrap">
      <ul className="landing-shortcuts">
        {SHORTCUT_PAGES.map(({ id, path, label }) => (
          <li key={id}>
            <Link to={path} className="landing-shortcut">
              <strong>{label}</strong>
              <span>{SUMMARIES[id]}</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
