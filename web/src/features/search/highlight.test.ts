import { describe, expect, test } from "vitest";
import { highlight, normalizeQuery } from "./highlight";

const marked = (text: string, q: string) =>
  highlight(text, normalizeQuery(q))
    .map((s) => (s.match ? `[${s.text}]` : s.text))
    .join("");

describe("highlight", () => {
  test("이름 접두", () => expect(marked("삼성전자", "삼성")).toBe("[삼성]전자"));
  test("이름 포함", () => expect(marked("삼성전자우", "전자")).toBe("삼성[전자]우"));
  test("초성은 맞는 음절을 표시한다", () => {
    expect(marked("삼성전자", "ㅅㅅㅈㅈ")).toBe("[삼성전자]");
    expect(marked("삼성바이오로직스", "ㅂㅇㅇ")).toBe("삼성[바이오]로직스");
    expect(marked("신세계", "ㅅㅅ")).toBe("[신세]계");
  });
  test("영문은 대소문자를 가리지 않는다", () => expect(marked("SK하이닉스", "sk")).toBe("[SK]하이닉스"));
  test("공백을 지우고 비교하고, 맞은 구간 안의 공백은 함께 표시한다", () => {
    expect(marked("KODEX 200", "kodex2")).toBe("[KODEX 2]00");
    expect(marked("KODEX 200", " 2 00 ")).toBe("KODEX [200]");
  });
  test("코드", () => expect(marked("005930", "0059")).toBe("[0059]30"));
  test("맞지 않으면 그대로", () => expect(marked("삼성전자", "ㅎㄷ")).toBe("삼성전자"));
});

test("normalizeQuery는 서버 규칙과 같다", () => {
  expect(normalizeQuery("  삼성 전자 ")).toBe("삼성전자");
  expect(normalizeQuery("naver")).toBe("NAVER");
  expect(normalizeQuery("   ")).toBe("");
});
