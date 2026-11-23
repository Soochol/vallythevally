// Lightweight Charts 라이선스가 요구하는 표기다(frontend.md §5.7). 로고를 끈 대신 링크를 늘 보이게 둔다.
export const ATTRIBUTION_URL = "https://www.tradingview.com/";

export function Attribution({ text, className }: { text: string; className?: string }) {
  return (
    <a href={ATTRIBUTION_URL} target="_blank" rel="noopener" className={className}>
      {text}
    </a>
  );
}
