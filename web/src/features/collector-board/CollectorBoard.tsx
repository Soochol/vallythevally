import type { CollectorAlert } from "../../api/generated/CollectorAlert";
import type { CollectorStatus } from "../../api/generated/CollectorStatus";
import type { CollectorStatusPage } from "../../api/generated/CollectorStatusPage";
import type { CollectorStock } from "../../api/generated/CollectorStock";
import type { CollectorUniverseChanges } from "../../api/generated/CollectorUniverseChanges";
import { useQueryClient } from "@tanstack/react-query";
import { useCollectorStatus } from "../../api/collector";
import { Skeleton, ErrorState } from "../overlay/State";
import { useNotificationAccess } from "./alerts";
import { BoardErrorBoundary } from "./BoardErrorBoundary";
import { CollectorStore } from "./CollectorStore";
import { alertKindLabel, bannerOf, dateText, keyStateOf, keyRoleLabel, messageRateText, phaseLabel, receivedAtIso, receivedAtText, restText, verdictOf } from "./labels";
import { Cell, Empty, Section, Status, Table, toneText } from "./parts";

export function CollectorBoard() {
  const queryClient = useQueryClient();
  const dropBoardData = () => queryClient.removeQueries({ queryKey: ["collector"], predicate: (q) => q.queryKey[1] !== "access" });
  return (
    <BoardErrorBoundary onRetry={dropBoardData}>
      <BoardContent />
    </BoardErrorBoundary>
  );
}

function BoardContent() {
  const status = useCollectorStatus();
  if (status.isPending) return <Skeleton label="수집 현황판을 불러오는 중" />;
  if (status.isError) return <ErrorState message="수집 현황을 불러오지 못했습니다" retry={() => void status.refetch()} />;
  const page = status.data;
  return (
    <div className="flex flex-col gap-4">
      <DaemonBand page={page} />
      {page.status === null ? <Empty>감독 데몬에서 받은 상태가 아직 없습니다.</Empty> : <Today status={page.status} />}
      {page.status && <Keys status={page.status} />}
      {page.status && <Universe changes={page.status.universe_changes} alerts={page.status.alerts} />}
      {page.status && <Observation day={page.status.observation_day} />}
      {page.status && <Alerts alerts={page.status.alerts} />}
      <CollectorStore />
    </div>
  );
}

function DaemonBand({ page }: { page: CollectorStatusPage }) {
  const banner = bannerOf(page.judgment);
  const receivedIso = page.received_at === null ? null : receivedAtIso(page.received_at);
  const notifications = useNotificationAccess();
  return (
    <div role={banner.alert ? "alert" : "status"} aria-label="감독 데몬" data-judgment={page.judgment} className={`flex flex-wrap items-center gap-x-4 gap-y-2 rounded-m border px-4 py-3 ${banner.alert ? "border-current bg-[color-mix(in_srgb,currentColor_12%,transparent)]" : "border-line bg-surface"} ${toneText(banner.tone)}`}>
      <Status tone={banner.tone}><strong className="text-m font-semibold">{banner.title}</strong></Status>
      <span className="text-s text-text-2">
        {page.received_at === null ? "받은 상태 없음" : receivedIso === null ? <>마지막으로 받은 상태 {receivedAtText(page.received_at)}</> : <>마지막으로 받은 상태 <time dateTime={receivedIso}>{receivedAtText(page.received_at)}</time></>}
      </span>
      <span className="ml-auto text-s text-text-2">
        {notifications.access === "default" && <button type="button" className="btn btn-sm" onClick={notifications.ask}>브라우저 알림 허용</button>}
        {notifications.access === "granted" && "브라우저 알림 켜짐"}
        {notifications.access === "denied" && "브라우저 알림이 막혀 있습니다. 브라우저 설정에서 허용하세요"}
      </span>
    </div>
  );
}

function Today({ status }: { status: CollectorStatus }) {
  const t = status.today;
  const tiles: readonly (readonly [string, number, string])[] = [
    ["계획 종목", t.planned_stocks, "종목"],
    ["받는 중", t.receiving_stocks, "종목"],
    ["등록 실패", t.register_failed_batches, "묶음"],
    ["끊김", t.disconnected_stocks, "종목"],
    ["인계됨", t.handed_off_stocks, "종목"],
    ["제외", t.excluded_stocks, "종목"],
  ];
  return (
    <Section id="collector-today" title="오늘의 요약" note={`${dateText(status.date)} · ${phaseLabel(status.phase)}`}>
      <dl className="grid grid-cols-3 gap-3 max-md:grid-cols-2">
        {tiles.map(([label, value, unit]) => (
          <div key={label} className="flex flex-col gap-0.5 rounded-m border border-line px-3 py-2">
            <dt className="text-s text-text-2">{label}</dt>
            <dd className="text-xl font-semibold">{value.toLocaleString("ko-KR")}<span className="ml-1 text-s font-normal text-text-2">{unit}</span></dd>
          </div>
        ))}
      </dl>
    </Section>
  );
}

function Keys({ status }: { status: CollectorStatus }) {
  return (
    <Section id="collector-keys" title="키별 상태" note={`${status.keys.length}개`}>
      {status.keys.length === 0 ? <Empty>활성 키가 없습니다.</Empty> : (
        <Table label="키별 상태" head={["키", "상태", "맡은 종목", "초당 메시지", "REST", "등록 실패", "재시작"]}>
          {status.keys.map((key) => {
            const state = keyStateOf(key.state);
            return (
              <tr key={`${key.name}-${key.app_key_hash_prefix}`}>
                <Cell first>
                  <span className="font-medium">{key.name}</span>
                  <span className="ml-2 text-s text-text-2">{keyRoleLabel(key.role)}</span>
                  <span className="ml-2 font-mono text-s text-text-3">{key.app_key_hash_prefix}</span>
                </Cell>
                <Cell><Status tone={state.tone}>{state.label}</Status></Cell>
                <Cell>{key.stocks.toLocaleString("ko-KR")}</Cell>
                <Cell>{messageRateText(key)}</Cell>
                <Cell>{restText(key.rest)}</Cell>
                <Cell>{key.register_failures}</Cell>
                <Cell>{key.restarts}</Cell>
              </tr>
            );
          })}
        </Table>
      )}
    </Section>
  );
}

const stockText = (s: CollectorStock) => `${s.code} ${s.name}`;

function Universe({ changes, alerts }: { changes: CollectorUniverseChanges | null; alerts: readonly CollectorAlert[] }) {
  const notes = alerts.filter((a) => a.kind === "plan_note");
  const groups: readonly (readonly [string, readonly string[]])[] = changes === null ? [] : [
    ["신규", changes.added.map(stockText)],
    ["폐지", changes.removed.map(stockText)],
    ["이름 변경", changes.renamed.map((r) => `${r.code} ${r.from} → ${r.to}`)],
    ["거래정지 시작", changes.halt_started.map(stockText)],
    ["거래정지 해제", changes.halt_lifted.map(stockText)],
  ];
  return (
    <Section id="collector-universe" title="종목 목록 변동" note="전날 목록 대비">
      {changes === null ? <Empty>아침 종목 목록을 아직 받지 않았습니다.</Empty> : (
        <div className="grid grid-cols-2 gap-3 max-md:grid-cols-1">
          {groups.map(([label, items]) => (
            <div key={label} className="flex min-w-0 flex-col gap-1 rounded-m border border-line px-3 py-2">
              <h4 className="text-s text-text-2">{label} <span className="text-text">{items.length.toLocaleString("ko-KR")}</span></h4>
              {items.length === 0 ? <p className="text-s text-text-3">없음</p> : <ul className="max-h-32 overflow-y-auto text-s">{items.map((item) => <li key={item} className="truncate">{item}</li>)}</ul>}
            </div>
          ))}
        </div>
      )}
      {notes.length > 0 && (
        <ul aria-label="종목 목록 안내" className="flex flex-col gap-1 text-m text-warning">
          {notes.map((n, i) => <li key={`${n.at}-${i}`} className="break-words [overflow-wrap:anywhere]">{n.message}</li>)}
        </ul>
      )}
    </Section>
  );
}

function Observation({ day }: { day: CollectorStatus["observation_day"] }) {
  const verdict = day === null ? null : verdictOf(day.verdict);
  return (
    <Section id="collector-observation" title="관측일 판단">
      {day === null || verdict === null ? <Empty>아직 판단 전입니다.</Empty> : (
        <>
          <Status tone={verdict.tone}><strong className="text-m font-semibold">{verdict.label}</strong></Status>
          {day.reasons.length === 0 ? <Empty>적힌 근거가 없습니다.</Empty> : <ul aria-label="관측일 판단 근거" className="list-disc pl-5 text-m">{day.reasons.map((r) => <li key={r} className="break-words [overflow-wrap:anywhere]">{r}</li>)}</ul>}
        </>
      )}
    </Section>
  );
}

function Alerts({ alerts }: { alerts: readonly CollectorAlert[] }) {
  return (
    <Section id="collector-alerts" title="경보" note={`${alerts.length}건`}>
      {alerts.length === 0 ? <Empty>경보가 없습니다.</Empty> : (
        <ul aria-label="경보 목록" className="flex max-h-72 flex-col overflow-y-auto text-m">
          {[...alerts].reverse().map((a, i) => (
            <li key={`${a.at}-${i}`} className="flex flex-wrap gap-x-3 border-b border-line py-1.5">
              <time className="font-mono text-s text-text-2">{a.at.replace("T", " ").slice(0, 19)}</time>
              <span className="min-w-0 break-words text-s text-warning [overflow-wrap:anywhere]">{alertKindLabel(a.kind)}</span>
              <span className="min-w-0 flex-1 break-words">{a.message}</span>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}
