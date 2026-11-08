import { expect, test } from "vitest";
import { ApiRequestError } from "../../api/http";
import { cellErrorView, olderErrorView } from "./cellError";

test("unknown_symbol은 정해진 문장과 종목 검색 버튼", () => {
  expect(cellErrorView(new ApiRequestError("unknown_symbol", "서버 문장"), "005930")).toEqual({
    text: "종목 005930을 찾을 수 없습니다. 상장 폐지되었거나 코드가 바뀌었을 수 있습니다.",
    action: "search",
  });
});

test("kiwoom_unavailable은 서버 문장과 다시 시도 버튼", () => {
  expect(cellErrorView(new ApiRequestError("kiwoom_unavailable", "키움 조회가 응답하지 않습니다."), "005930")).toEqual({
    text: "키움 조회가 응답하지 않습니다.",
    action: "retry",
  });
});

test("서버에 닿지 못해도 다시 시도할 수 있다", () => {
  expect(cellErrorView(new ApiRequestError("network", "서버에 연결하지 못했습니다"), "005930").action).toBe("retry");
});

test("키움 인증 실패는 다시 시도 버튼이 없다", () => {
  expect(cellErrorView(new ApiRequestError("kiwoom_auth_failed", "키움 인증 실패"), "005930").action).toBeNull();
});

test("과거 페이지 실패는 서버 문장을 붙이고, 인증 실패만 다시 시도를 두지 않는다", () => {
  expect(olderErrorView(new ApiRequestError("kiwoom_unavailable", "키움 조회에 실패했습니다. 잠시 뒤 다시 시도하세요"), "005930")).toEqual({
    text: "과거 봉을 받지 못했습니다. 키움 조회에 실패했습니다. 잠시 뒤 다시 시도하세요",
    retry: true,
  });
  expect(olderErrorView(new ApiRequestError("kiwoom_auth_failed", "키움 인증에 실패했습니다. 운영자가 설정을 확인해야 합니다"), "005930")).toEqual({
    text: "과거 봉을 받지 못했습니다. 키움 인증에 실패했습니다. 운영자가 설정을 확인해야 합니다",
    retry: false,
  });
});
