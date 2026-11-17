import { QueryClient } from "@tanstack/react-query";
import { expect, test } from "vitest";
import { refetchFailedNames } from "./refetchNamesOnConnect";

function flaky(client: QueryClient, key: readonly string[], recovered: unknown, failing: boolean) {
  const state = { failing, calls: 0 };
  const run = () => client.prefetchQuery({
    queryKey: key,
    retry: false,
    queryFn: () => {
      state.calls += 1;
      return state.failing ? Promise.reject(new Error("not_connected")) : Promise.resolve(recovered);
    },
  });
  return { state, run };
}

test("오류 상태인 종목 이름 질의만 다시 받는다", async () => {
  const client = new QueryClient();
  const info = flaky(client, ["symbol", "005930"], "삼성전자", true);
  const loaded = flaky(client, ["symbol", "000660"], "SK하이닉스", false);
  const search = flaky(client, ["symbols", "삼성"], ["삼성전자"], true);
  const other = flaky(client, ["fundamentals", "005930"], 1, true);
  await Promise.all([info.run(), loaded.run(), search.run(), other.run()]);
  info.state.failing = false;
  search.state.failing = false;
  await refetchFailedNames(client);
  expect(client.getQueryData(["symbol", "005930"])).toBe("삼성전자");
  expect(client.getQueryData(["symbols", "삼성"])).toEqual(["삼성전자"]);
  expect(loaded.state.calls).toBe(1);
  expect(other.state.calls).toBe(1);
});
