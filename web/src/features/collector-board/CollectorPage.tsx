import { Link, Navigate } from "react-router";
import { collectorAllowed, useCollectorAccess } from "../../api/collector";
import { Toast } from "../toast/Toast";
import { CollectorBoard } from "./CollectorBoard";

export function CollectorPage() {
  const access = useCollectorAccess();
  if (access.isPending) return <div className="h-dvh bg-bg" aria-busy="true" aria-label="수집 현황판 권한을 확인하는 중" />;
  if (!collectorAllowed(access)) return <Navigate to="/" replace />;
  return (
    <main className="h-dvh overflow-y-auto bg-bg text-text">
      <div className="mx-auto flex max-w-[64rem] flex-col gap-4 px-4 py-4">
        <header className="flex items-center gap-3">
          <Link to="/" className="tb-btn">‹ 차트</Link>
          <h1 className="text-l font-semibold">수집 현황판</h1>
        </header>
        <CollectorBoard />
      </div>
      <Toast />
    </main>
  );
}
