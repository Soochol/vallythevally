# e2e 시험 작성 기준

`web/e2e`의 Playwright 시험을 쓰거나 고치기 전에 읽는다. e2e를 돌리는 방법과 산출물 경로는 [로컬 웹 검사와 E2E](web-checks.md)에 있다. 자동으로 확인할 수 있는 규칙은 [기계 검사](#기계-검사)에서 막고, 나머지는 이 문서와 리뷰가 맡는다.

시험은 `harness.ts`의 `test`와 `scenario`를 쓴다.

## 한 시험은 한 동작을 확인한다

여러 대상(그리기 도구 36개 등)을 확인할 때 한 시험 안의 반복문으로 돌지 않는다. 시험 하나가 길어지면 부하 때 시험 제한 90초를 넘긴다.

- 대상을 그룹(한 그룹 4개 이하)으로 나누고 그룹마다 `test`를 만든다. 파일 최상위 `for` 안에서 `test(...)`를 호출한다.
- 그룹 목록을 합치면 전체 목록과 같다는 빠짐없음 시험을 함께 둔다. 대상이 늘어도 그룹에서 빠지면 이 시험이 실패한다.

예는 [`web/e2e/drawing-tools-all.spec.ts`](../web/e2e/drawing-tools-all.spec.ts)다. `SLICES`의 `slice`마다 `test(\`모든 도구 ${slice.name}: …\`)`를 만들고, 빠짐없음 시험이 `TOOLS` 36개와 모든 그룹·배치 형태를 `SLICES`가 빠짐없이 담는지, 한 묶음이 `SLICE_SIZE`를 넘지 않는지 확인한다.

## 시간 예산은 30초다

부하가 없을 때 시험 하나는 30초 이하여야 한다. 시험 제한 90초를 부하 때 측정한 배율 3배로 나눈 값이다. 넘으면 위 방식으로 나눈다. 예산을 넘는다고 `test.setTimeout`이나 `test.slow`로 제한을 늘리지 않는다.

반대로 너무 잘게 쪼개지 않는다. 시험마다 새 context를 만들고 앱을 열기 때문에 시험 하나에 약 0.2초(Navigate와 Before Hooks)가 든다. 몇 초짜리 시험을 단언 하나씩으로 쪼개면 전체가 느려진다. 한 동작을 확인하는 데 필요한 단언은 한 시험에 둔다.

예산 초과는 실패가 아니라 경고다. 실행이 끝나면 `budget-reporter.ts`가 30초를 넘은 시험을 오래 걸린 순서로 출력하고 실행의 `results/budget.json`에 남긴다. 예산은 `VALLY_E2E_BUDGET_MS`로 바꿀 수 있다.

시험별 시간은 같은 `results/`에 `durations.json`으로도 남는다. 최상위는 `runStart`(실행 시작 시각)와 `count`(시험 수), `tests`(시험마다 `file`, `line`, `title`, `status`, `durationMs`, `workerIndex`, `startMs`(실행 시작부터 잰 시작 시각), `retry`)다. 재시도, 실패, 건너뜀도 한 줄씩 들어간다. 실행 폴더는 곧 지워지므로 같은 JSON을 gzip과 base64로 바꾼 한 줄 `e2e-durations: <base64>`도 표준 출력에 나와 chute 검증 로그에 보존된다. 이 줄은 마지막 요약보다 앞에 나온다. 로그에서 JSON으로 되돌린다.

```
grep '^e2e-durations: ' e2e.1.log | cut -d' ' -f2 | base64 -d | gunzip
```

## 시간 대신 상태와 이벤트를 기다린다

고정 시간을 기다리지 말고 기다릴 상태를 정한다.

- web-first 단언: `expect(locator).toHaveAttribute(...)`, `toBeVisible()` 등
- `expect.poll`: 값이 조건을 만족할 때까지 다시 읽는다. 시나리오가 저장한 상태나 요청 기록처럼 node 쪽 값만 읽을 때는 간격이 촘촘한 `pollSaved`(`harness.ts`)를 쓴다
- `page.waitForResponse`
- `scenario.hold`로 응답을 붙잡고 `reply`로 풀어 늦은 응답을 시험한다
- 앱이 내놓는 `data-*` 속성(`data-value` 등)

`expect`의 제한 시간은 기본 15초이고 더 짧게 두지 않는다. 바깥 `toPass`가 다시 시도하는 안쪽 단언 하나의 짧은 제한만 예외다. 부하에서 짧은 제한이 먼저 실패하면 흔들리는 시험이 된다.

## 고정 대기는 "N초 안에 일어나지 않는다"를 볼 때만 쓴다

무언가 일어나지 않음을 보려면 시간이 지나야 하므로 이때만 고정 대기를 쓴다.

1. 먼저 `clockStart`와 `page.clock`(`install`, `fastForward`)으로 가상 시간을 넘긴다. 예는 [`financial-consistency.spec.ts`](../web/e2e/financial-consistency.spec.ts)의 `page.clock.install`과 `fastForward`다.
2. 실제 시간이 필요할 때만 `harness.ts`의 `fixedWait(page, ms, reason)`을 쓴다. 이유는 주석이 아니라 인수로 적는다. 이유가 비면 시험이 실패하고, 이유와 시간이 시험 annotation `fixed-wait`으로 HTML 보고서에 남는다.

`page.waitForTimeout`을 시험에서 직접 부르지 않는다. 기계 검사가 막는다.

`clockStart`와 `clock.setSystemTime` 주의사항:

- `clockStart`는 브라우저 시계를 고정한다. 서버 기준 재시도 시험은 합성 응답의 `Date` 헤더와 함께 명시하고 필요하면 `clockStart: null`로 실행한다.
- Playwright `clock.setSystemTime`은 벽시계만 바꾸고 `performance.now`는 그대로다.

## 시험은 서로 독립이다

Playwright 설정이 `fullyParallel: true`라서 같은 파일의 시험도 서로 다른 worker에서 동시에 돈다. 시험 사이에 상태를 공유하지 않는다.

- 상태는 `scenario` fixture가 시험마다 새로 만든다. `scenario.documents`는 한 시험 안의 탭과 추가 context가 공유하고 다음 시험에서 새로 만든다.
- `beforeAll`, `afterAll`, `serial` 모드, 모듈 수준의 바뀌는 변수(`let`, `var`)를 쓰지 않는다.
- 앞 시험의 결과에 기대는 시험을 쓰지 않는다. 한 시험이 필요로 하는 상태는 그 시험이 만든다.

## 다시 시도로 덮지 않는다

`retries`는 0이다. 흔들리는 시험은 다시 시도로 덮지 않고 원인을 고친다.

## 시간에 민감한 새 시험은 부하에서 반복해 확인한다

대기, 애니메이션, 실시간 프레임, 늦은 응답을 다루는 새 시험은 부하를 흉내 내 반복으로 확인하고, 명령과 결과를 PR 본문에 적는다.

재현 수단은 두 가지다.

- 결정적 방법: `scenario.hold`와 `reply`로 응답을 늦추고, `clockStart`와 `page.clock`으로 가상 시간을 넘기고, 앱이 내놓는 상태·전환 완료 신호(`data-*`, `aria-*`)를 기다린다.
- 그 실행에만 거는 제한: 아래 `VALLY_E2E_CPU_THROTTLE`이다.

PC 전체에 인위적 부하를 걸지 않는다. 무한 루프, `stress`·`stress-ng`, 코어 수만큼의 바쁜 프로세스, 같은 시험 실행을 여러 벌 동시에 띄우는 것이 모두 해당한다. 이 PC는 다른 작업자와 chute 병합 검증이 함께 쓰므로 전체 부하는 그들을 함께 느리게 하고 다른 시험을 흔든다. 위 수단으로 재현하지 못하면 부하를 키우지 않고, 무엇을 시도했는지 보고하고 멈춘다.

```sh
env VALLY_E2E_CPU_THROTTLE=4 python3 scripts/web.py e2e --repeat-each=20 --workers=6 e2e/<파일>.spec.ts:<줄>
```

`VALLY_E2E_CPU_THROTTLE`은 1 이상의 수이며, `scenario` fixture가 그 context의 모든 페이지에 Chromium CPU 제한을 건다. 실제 부하는 시험 실행기와 정적 호스트도 느리게 하므로 완전히 같지는 않지만, 브라우저 안의 타이머·애니메이션·렌더 경합을 반복으로 재현하기에는 충분하다. `--repeat-each`와 `--workers`는 Playwright 인수다. `--workers`가 12를 넘으면 12로 줄어든다.

## 기계 검사

| 무엇을 | 어디서·언제 | 허용 목록 | 고칠 방법 |
|---|---|---|---|
| `harness.ts` 밖의 `waitForTimeout` | [`scripts/e2e_rules.py`](../scripts/e2e_rules.py). `python3 scripts/web.py check`의 첫 단계이고, chute batch의 `check`로 PR 머지 전에 돈다 | [`web/e2e/rules-baseline.json`](../web/e2e/rules-baseline.json)의 `waitForTimeout`(파일별 개수) | 상태·이벤트를 기다리거나 `page.clock`, 실제 시간이 필요하면 `fixedWait` |
| `serial` 모드(`describe.serial`, `mode: "serial"`) | 같음 | `serial` | 시험마다 `scenario` fixture로 상태를 새로 만든다 |
| `beforeAll`, `afterAll` | 같음 | `beforeAll-afterAll` | 같음 |
| spec 파일의 모듈 수준 `let`, `var` | 같음 | `module-variable` | 같음 |
| `test.setTimeout`, `test.slow`, `describe.configure`의 `timeout` | 같음 | `test-timeout` | 30초 예산을 넘는 시험은 그룹별 시험으로 나눈다 |
| 30초를 넘은 시험 | [`web/e2e/budget-reporter.ts`](../web/e2e/budget-reporter.ts). e2e 실행이 끝날 때 보고하고 `results/budget.json`에 남긴다. 경고만 하며 종료 코드를 바꾸지 않는다 | 없음 | 그룹별 시험으로 나눈다 |

허용 목록은 지금 있는 시험이 걸리는 곳만 담은 파일별 개수다. 양쪽으로 맞춘다. 개수가 늘면 실패하고 고칠 방법을 출력한다. 개수가 줄어도 실패하고 허용 목록을 낮추라고 출력한다. 줄어든 자리가 다시 차는 것을 막기 위해서다. 줄 번호가 아니라 개수라서 다른 줄을 고쳐도 걸리지 않는다. 허용 목록을 늘려서 새 위반을 통과시키지 않는다.

반복문 안의 여러 대상과 짧은 `expect` 제한은 정규식으로 가려낼 수 없어(정당한 `toPass` 안의 짧은 제한과 모양이 같다) 이 문서와 시간 예산 보고에 맡긴다.

## 임시 시험 파일

임시 웹 시험 파일은 `web/` 안에 둔다. 밖에서는 ESM 설정이 적용되지 않아 `import.meta`가 실패할 수 있다.
