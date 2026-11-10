import { expect, test } from "vitest";
import type { ConnectionStatus } from "../../api/generated/ConnectionStatus";
import type { Connection } from "../../api/socket";
import { connectionView } from "./connectionView";

const kst = (iso: string) => Date.parse(`${iso}+09:00`) / 1000;
const MON_1000 = kst("2026-11-09T10:00:00");
const open = (status: Partial<ConnectionStatus>): Connection => ({
  socket: "open",
  status: { realtime: "live", since: kst("2026-11-09T14:02:00"), backfilling: false, ...status },
});

test.each<[string, Connection, number, ReturnType<typeof connectionView>]>([
  ["연결 중", { socket: "connecting" }, MON_1000, { tone: "gray", pulse: false, text: "서버에 다시 연결하는 중" }],
  ["끊김", { socket: "closed" }, MON_1000, { tone: "gray", pulse: false, text: "서버에 다시 연결하는 중" }],
  ["live, 장중", open({}), MON_1000, { tone: "mint", pulse: true, text: "실시간 연결됨" }],
  ["live, 08:00 정각은 장중", open({}), kst("2026-11-09T08:00:00"), { tone: "mint", pulse: true, text: "실시간 연결됨" }],
  ["live, 20:00은 장 닫힘", open({}), kst("2026-11-09T20:00:00"), { tone: "mint", pulse: false, text: "장 닫힘: 체결 없음" }],
  ["live, 07:59는 장 닫힘", open({}), kst("2026-11-09T07:59:00"), { tone: "mint", pulse: false, text: "장 닫힘: 체결 없음" }],
  ["live, 토요일", open({}), kst("2026-11-07T10:00:00"), { tone: "mint", pulse: false, text: "장 닫힘: 체결 없음" }],
  ["live, 일요일", open({}), kst("2026-11-08T10:00:00"), { tone: "mint", pulse: false, text: "장 닫힘: 체결 없음" }],
  [
    "reconnecting은 since를 보인다",
    open({ realtime: "reconnecting" }),
    MON_1000,
    { tone: "amber", pulse: false, text: "키움에 다시 연결하는 중 (14:02부터)" },
  ],
  ["backfilling", open({ backfilling: true }), MON_1000, { tone: "amber", pulse: false, text: "끊긴 구간 메우는 중" }],
  [
    "reconnecting이 backfilling보다 먼저",
    open({ realtime: "reconnecting", backfilling: true }),
    MON_1000,
    { tone: "amber", pulse: false, text: "키움에 다시 연결하는 중 (14:02부터)" },
  ],
  ["halted", open({ realtime: "halted", backfilling: true }), MON_1000, { tone: "red", pulse: false, text: "실시간 멈춤: 서버를 다시 켜야 합니다" }],
])("%s", (_name, c, now, expected) => {
  expect(connectionView(c, now)).toEqual(expected);
});
