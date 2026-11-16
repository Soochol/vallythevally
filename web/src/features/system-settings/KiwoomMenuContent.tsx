import { useKiwoomLinkStore } from "../../stores/kiwoomLink";

export function KiwoomMenuContent() {
  const message = useKiwoomLinkStore((s) => s.status?.message);
  return <p className="text-m leading-relaxed text-text">{message ?? "연결 상태를 불러오는 중입니다"}</p>;
}
