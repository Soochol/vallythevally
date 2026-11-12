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

test("같은 명령 객체를 재등록한 뒤 이전 등록을 해제해도 새 등록은 남는다", () => {
  const command = { id: "same-object", label: "같은 명령", run: () => {} };
  const unregisterOld = registerSearchCommands([command]);
  const unregisterNew = registerSearchCommands([command]);
  try {
    unregisterOld();
    expect(searchCommandsSnapshot()).toEqual([command]);
    unregisterNew();
    expect(searchCommandsSnapshot()).toEqual([]);
  } finally {
    unregisterOld();
    unregisterNew();
  }
});

test("같은 id를 다른 객체로 교체한 뒤 이전 등록의 해제는 목록과 구독을 바꾸지 않는다", () => {
  const original = { id: "replaced-command", label: "이전 명령", run: () => {} };
  const replacement = { ...original, label: "새 명령" };
  let notifications = 0;
  const unsubscribe = subscribeSearchCommands(() => notifications++);
  const unregisterOld = registerSearchCommands([original]);
  const unregisterNew = registerSearchCommands([replacement]);
  try {
    unregisterOld();
    expect(searchCommandsSnapshot()).toEqual([replacement]);
    expect(notifications).toBe(2);
    unregisterNew();
    expect(searchCommandsSnapshot()).toEqual([]);
  } finally {
    unsubscribe();
    unregisterOld();
    unregisterNew();
  }
});

test("등록 해제를 반복해도 목록과 구독은 바뀌지 않는다", () => {
  const command = { id: "repeated-disposal", label: "한 번 해제", run: () => {} };
  let notifications = 0;
  const unsubscribe = subscribeSearchCommands(() => notifications++);
  const unregister = registerSearchCommands([command]);
  try {
    unregister();
    expect(searchCommandsSnapshot()).toEqual([]);
    expect(notifications).toBe(2);
    unregister();
    expect(searchCommandsSnapshot()).toEqual([]);
    expect(notifications).toBe(2);
  } finally {
    unsubscribe();
    unregister();
  }
});

test("한 등록 호출에서 중복된 id는 마지막 명령 하나만 남긴다", () => {
  const original = { id: "duplicate-in-call", label: "이전 항목", run: () => {} };
  const replacement = { ...original, label: "마지막 항목" };
  const unregister = registerSearchCommands([original, replacement]);
  try {
    expect(searchCommandsSnapshot()).toEqual([replacement]);
  } finally {
    unregister();
  }
});
