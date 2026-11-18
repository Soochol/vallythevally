import type { CollectorDayBytes } from "../../api/generated/CollectorDayBytes";
import type { CollectorDisk } from "../../api/generated/CollectorDisk";
import { useCollectorCoverage, useCollectorDisk } from "../../api/collector";
import { ErrorState, Skeleton } from "../overlay/State";
import { bytesText, coverageRatio, dateText, dayStateOf } from "./labels";
import { Cell, Empty, Section, Status, Table } from "./parts";

export function CollectorStore() {
  return (
    <>
      <Coverage />
      <Disk />
    </>
  );
}

function Coverage() {
  const coverage = useCollectorCoverage();
  return (
    <Section id="collector-coverage" title="날짜별 커버리지" note="최근 날짜부터">
      {coverage.isPending ? <Skeleton label="커버리지를 불러오는 중" /> : coverage.isError ? <ErrorState message="커버리지를 받지 못했습니다. 감독 데몬이 응답해야 읽을 수 있습니다" retry={() => void coverage.refetch()} /> : coverage.data.days.length === 0 ? <Empty>정리된 날짜가 없습니다.</Empty> : (
        <Table label="날짜별 커버리지" head={["날짜", "상태", "원문 대조", "받은 종목 / 계획 종목"]}>
          {coverage.data.days.map((day) => {
            const state = dayStateOf(day.state);
            return (
              <tr key={day.date}>
                <Cell first>{dateText(day.date)}</Cell>
                <Cell><Status tone={state.tone}>{state.label}</Status></Cell>
                <Cell>{day.verified === null ? "—" : day.verified ? "통과" : "실패"}</Cell>
                <Cell>{coverageRatio(day)}</Cell>
              </tr>
            );
          })}
        </Table>
      )}
    </Section>
  );
}

function Disk() {
  const disk = useCollectorDisk();
  return (
    <Section id="collector-disk" title="디스크 사용량">
      {disk.isPending ? <Skeleton label="디스크 사용량을 불러오는 중" /> : disk.isError ? <ErrorState message="디스크 사용량을 받지 못했습니다. 감독 데몬이 응답해야 읽을 수 있습니다" retry={() => void disk.refetch()} /> : <DiskBody disk={disk.data} />}
    </Section>
  );
}

function sizesByDate(disk: CollectorDisk): readonly { date: number; raw: number | null; store: number | null }[] {
  const dates = new Set([...disk.disk.raw, ...disk.disk.store].map((d) => d.date));
  const at = (list: readonly CollectorDayBytes[], date: number) => list.find((d) => d.date === date)?.bytes ?? null;
  return [...dates].sort((a, b) => b - a).map((date) => ({ date, raw: at(disk.disk.raw, date), store: at(disk.disk.store, date) }));
}

function DiskBody({ disk }: { disk: CollectorDisk }) {
  const fs = disk.disk.filesystem;
  const days = sizesByDate(disk);
  return (
    <>
      {fs === null ? <Empty>파일 시스템 용량을 읽지 못했습니다.</Empty> : (
        <p className="text-m">
          여유 <strong className="font-semibold">{bytesText(fs.free_bytes)}</strong>
          <span className="text-text-2"> / 전체 {bytesText(fs.total_bytes)}</span>
        </p>
      )}
      {days.length === 0 ? <Empty>날짜별 사용량이 없습니다.</Empty> : (
        <Table label="날짜별 디스크 사용량" head={["날짜", "원문", "정리본"]}>
          {days.map((d) => (
            <tr key={d.date}>
              <Cell first>{dateText(d.date)}</Cell>
              <Cell>{d.raw === null ? "—" : bytesText(d.raw)}</Cell>
              <Cell>{d.store === null ? "—" : bytesText(d.store)}</Cell>
            </tr>
          ))}
        </Table>
      )}
    </>
  );
}
