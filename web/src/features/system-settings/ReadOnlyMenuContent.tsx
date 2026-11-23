import type { KiwoomTarget } from "../../api/generated/KiwoomTarget";
import type { SystemSettings } from "../../api/generated/SystemSettings";
import { useSystemSettings } from "../../api/system";
import type { SystemMenuId } from "./menus";

type Entry = readonly [label: string, value: string];

const onOff = (on: boolean) => (on ? "켜짐" : "꺼짐");

const targetText = (target: KiwoomTarget) => `${target.kind === "kiwoom" ? "키움" : "로컬 시험 서버"}${target.host ? ` · ${target.host}` : ""}`;

const ENTRIES: Record<"general" | "data" | "about", (s: SystemSettings) => readonly Entry[]> = {
  general: (s) => [
    ["서버 주소", s.bind],
    ["로그 수준", s.logFilter],
    ["접속 대상", targetText(s.kiwoomTarget)],
    ["서버를 켤 때 스크리너 갱신", onOff(s.screenerUpdateOnStart)],
  ],
  data: (s) => [
    ["차트 데이터베이스", s.dbPath],
    ["스크리너 데이터베이스", s.screenerDbPath],
    ["재무 데이터베이스", s.financialDbPath],
    ["토큰 파일", s.tokenPath],
    ["키 파일", s.keyPath],
    ["잠금 파일", s.lockPath],
    ["화면 파일 폴더", s.staticDir],
  ],
  about: (s) => [
    ["서버 버전", s.serverVersion],
    ["접속 대상", targetText(s.kiwoomTarget)],
  ],
};

export function ReadOnlyMenuContent({ menu }: { menu: Extract<SystemMenuId, "general" | "data" | "about"> }) {
  const settings = useSystemSettings();
  if (settings.isPending) return <p className="text-m text-text-2">설정을 불러오는 중입니다</p>;
  if (settings.isError) return <p role="alert" className="text-m text-danger">설정을 불러오지 못했습니다</p>;
  return (
    <dl className="grid grid-cols-[minmax(0,10rem)_minmax(0,1fr)] gap-x-4 gap-y-3 text-m max-md:grid-cols-1 max-md:gap-y-1">
      {ENTRIES[menu](settings.data).map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-text-2">{label}</dt>
          <dd className="min-w-0 break-all font-mono text-text max-md:mb-2">{value}</dd>
        </div>
      ))}
    </dl>
  );
}
