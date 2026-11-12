import { expect, test } from "vitest";
import { registerSearchCommands, searchCommandsSnapshot, subscribeSearchCommands } from "./registry";

test("다른 기능이 명령을 등록하고 제거하면 구독자와 목록에 반영한다", () => {
  let notifications = 0;
  const unsubscribe = subscribeSearchCommands(() => notifications++);
  const command = { id: "test-command", label: "시험 명령", run: () => {} };
  const unregister = registerSearchCommands([command]);
  expect(searchCommandsSnapshot()).toContain(command);
  expect(notifications).toBe(1);
  unregister();
  expect(searchCommandsSnapshot()).not.toContain(command);
  expect(notifications).toBe(2);
  unsubscribe();
});
