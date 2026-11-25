import type { KiwoomTarget } from "../../api/generated/KiwoomTarget";
import type { SystemSettings } from "../../api/generated/SystemSettings";
import { useSystemSettings } from "../../api/system";
import { ErrorState, Skeleton } from "../overlay/State";
import { Badge } from "../ui/Badge";
import type { SystemMenuId } from "./menus";

type Entry = readonly [label: string, value: string, code?: true];

const onOff = (on: boolean) => (on ? "켜짐" : "꺼짐");

const targetText = (target: KiwoomTarget) => `${target.kind === "kiwoom" ? "키움" : "로컬 시험 서버"}${target.host ? ` · ${target.host}` : ""}`;

const ENTRIES: Record<"general" | "data" | "about", (s: SystemSettings) => readonly Entry[]> = {
  general: (s) => [
    ["서버 주소", s.bind, true],
    ["로그 수준", s.logFilter, true],
    ["접속 대상", targetText(s.kiwoomTarget)],
    ["서버를 켤 때 스크리너 갱신", onOff(s.screenerUpdateOnStart)],
  ],
  data: (s) => [
    ["차트 데이터베이스", s.dbPath, true],
    ["스크리너 데이터베이스", s.screenerDbPath, true],
    ["재무 데이터베이스", s.financialDbPath, true],
    ["수집 호가 폴더", s.hogaDataDir ?? "미설정", s.hogaDataDir !== null ? true : undefined],
    ["공용 자료 폴더", s.sharedDataDir ?? "미설정", s.sharedDataDir !== null ? true : undefined],
    ["토큰 파일", s.tokenPath, true],
    ["키 파일", s.keyPath, true],
    ["잠금 파일", s.lockPath, true],
    ["화면 파일 폴더", s.staticDir, true],
  ],
  about: (s) => [
    ["서버 버전", s.serverVersion, true],
    ["접속 대상", targetText(s.kiwoomTarget)],
  ],
};

export function ReadOnlyMenuContent({ menu }: { menu: Extract<SystemMenuId, "general" | "data" | "about"> }) {
  const settings = useSystemSettings();
  if (settings.isPending) return <Skeleton label="설정을 불러오는 중입니다" />;
  if (settings.isError) return <ErrorState message="설정을 불러오지 못했습니다" retry={() => void settings.refetch()} />;
  return (
    <section aria-label={MENU_TITLE[menu]} className="flex flex-col gap-3 rounded-m border border-line bg-surface p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge>서버 설정 · 읽기 전용</Badge>
        <p className="min-w-0 text-s text-text-2">바꾸려면 서버의 .env 설정을 고치고 서버를 다시 켭니다</p>
      </div>
      <dl className="grid grid-cols-[minmax(0,10rem)_minmax(0,1fr)] gap-x-4 gap-y-3 text-m max-md:grid-cols-1 max-md:gap-y-1">
        {ENTRIES[menu](settings.data).map(([label, value, code]) => (
          <div key={label} className="contents">
            <dt className="text-text-2">{label}</dt>
            <dd className={`min-w-0 break-all text-text max-md:mb-2 ${code ? "font-mono" : ""}`}>{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

const MENU_TITLE = { general: "일반 설정", data: "데이터 저장소", about: "서버 정보" } as const;
