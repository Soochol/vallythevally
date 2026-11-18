import { useEffect } from "react";
import { useMockEnvironment } from "../../stores/kiwoomLink";

const MOCK_TITLE_PREFIX = "[모의] ";

export function MockBadge() {
  const mock = useMockEnvironment();
  useEffect(() => {
    if (!mock) return;
    const original = document.title;
    document.title = MOCK_TITLE_PREFIX + original;
    return () => { document.title = original; };
  }, [mock]);
  if (!mock) return null;
  return <span className="mock-badge" role="status" title="키움 모의투자 서버에 연결합니다. 실계좌가 아닙니다">모의투자</span>;
}
