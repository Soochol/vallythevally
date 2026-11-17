# 무거운 e2e 시험 줄이기 플랜

작성일 2026-11-17. 승인 시점의 기록이며 구현 중 바뀐 것은 반영하지 않는다.

기준: `origin/main` b9e226e.

## 사용자가 풀려는 문제

사용자의 말(그대로): "b + 무거운 e2e 파악해서 개선하는 방안". b(chute 범인 찾기 재확인 단축)는 chute 저장소의 플랜 post-recheck가 맡는다. 이 플랜은 vallythevally에서 시간을 많이 쓰는 e2e를 찾아 줄인다.

머지 뒤 e2e(`scripts/web.py e2e --workers=6`, 약 790개 시험)는 부하가 없을 때 8.0~8.7분이 걸리고, 그 가운데 99% 이상이 Playwright 단계다(e2e-time 보고서 2절). 시험이 잡는 제품 동작은 줄이지 않고 시간을 줄인다.

## 근거로 쓴 기록

- chute 머지 뒤 검사 로그 `~/.local/state/chute/repos/Soochol__vallythevally/reports/commit-*/post/verify/e2e.*.log`(list 리포터의 시험별 시간).
- post 슬롯의 실행 기록 `~/.local/state/chute/slots/Soochol__vallythevally/post/target/web-runs/e2e-*/report/index.html`. Playwright HTML 보고서 안의 zip을 풀면 시험마다 `workerIndex`, `startTime`, `duration`, 단계(`steps`)별 시간이 있다.
- 부하가 낮았던 세 번(e2e-f4lerpyi 1ffeb0c 2회차 통과 483초, e2e-4gfld8rn 9f2fdcb 510초, e2e-dlwpb4f1 7a4db6c 507초)을 기준으로 삼았다. 부하가 높았던 실행(244eb37·aa0a529·516f7ce·85daeaf)은 흔들림을 볼 때만 썼다.
- 기록이 충분해 새로 재지는 않았다. 아래 "예상 효과"의 숫자는 기준 세 번의 시험별 시간으로 Playwright 배분을 흉내 낸 값이다. 지금 설정의 흉내 값(479·506·503초)은 실제 Playwright 단계 시간(483·510·507초)과 1% 안에서 맞는다.

## 어디에 시간을 쓰는가

e2e-f4lerpyi(783개 시험, 시험 시간 합 2342초, 벽시계 480초) 기준이다.

### 1. 시험 정리 단계의 5초 대기: 시험 시간 합의 15~21%

시험마다 Playwright의 "After Hooks"가 보통 50~70ms인데, 시험의 약 11%(783개 중 72~98개)는 정확히 5.01~5.02초가 걸린다. 다섯 실행에서 이렇게 쓴 시간은 361·416·436·491초(부하 낮음)와 636초(부하 높음, 125개)다.

원인은 `web/playwright.config.ts`의 `screenshot: "only-on-failure"`다. Playwright 1.65는 이 설정에서 context를 닫기 전에 열린 모든 페이지를 임시로 찍어 둔다(`ArtifactsRecorder.willCloseBrowserContext` → `SnapshotRecorder.captureTemporary`, `page.screenshot({ timeout: 5e3 })`, 실패는 삼킨다). 이 임시 촬영이 끝나지 않는 페이지에서 5초를 다 쓰고 나서야 "Close context"(4~8ms)로 넘어간다. 통과한 시험에서는 찍은 그림을 버린다.

어느 시험이 걸리는지는 회차마다 다르다(다섯 실행에서 매번 걸린 시험 10개, 한 번이라도 걸린 시험 240개). 시계 고정, 프레임 조작, 새로고침, 실시간 프레임, 페이지 여러 개 같은 시험 특성과도 상관이 없다(모두 10~16%). 특정 시험의 문제가 아니라 설정 하나의 문제다.

### 2. 파일 단위 배분 때문에 끝에 worker 하나만 남는다: 벽시계의 약 18%

Playwright는 `fullyParallel`이 꺼져 있으면 한 파일의 시험을 한 worker에서 차례로 돌리고, 파일을 이름 순서로 나눠 준다(`win-journey.spec.ts`만 `test.describe.configure({ mode: "parallel" })`로 예외). 그래서 이름이 뒤쪽인 큰 파일 `win-manage.spec.ts`(23개, 120초)가 360초에 시작해 480초에 끝나는 동안 나머지 다섯 worker는 361~401초에 일을 마치고 논다. worker별 일한 시간은 479·363·360·374·366·400초이고, 시험 시간 합을 6으로 나눈 하한은 390초다.

### 3. 오래 걸리는 시험과 파일

시험 시간 분포는 고르게 넓다. 10초 넘는 시험은 23개(12%), 5초 넘는 시험은 143개(47%)다. 파일 116개 가운데 상위 10개가 40%, 상위 20개가 55%를 쓴다.

| 파일 | 시험 수 | 시간 합(기준 세 번 평균) | 비율 |
|---|---|---|---|
| drawing-tools-all | 29 | 185초 | 7.6% |
| win-journey | 43 | 177초 | 7.3% |
| win-manage | 23 | 119초 | 4.9% |
| chart-readability | 10 | 103초 | 4.2% |
| drawing-dock-move | 16 | 79초 | 3.2% |
| drawing-dock-collapse | 22 | 70초 | 2.9% |
| chart-settings | 20 | 63초 | 2.6% |
| drawing-engine | 14 | 57초 | 2.4% |
| legend-panels | 14 | 56초 | 2.3% |
| win-float | 17 | 56초 | 2.3% |

가장 긴 시험은 indicator-inspector:27(22초), drawing-tools-all:268(19초), drawing-modes:120(18초), drawing-engine:231(15초), drawing-tools-all:459(15초)다. 상위 셋째·넷째와 둘째는 도구 그룹이나 도구 36개를 한 시험 안에서 차례로 도는 반복문이다.

### 4. 그 밖의 원인은 작다

- 고정 대기(`waitForTimeout`): 합 58초(2.5%). 큰 것은 win-manage의 6초 두 번("6초 안에 다시 보내지 않는다"를 보는 부정 확인)과 drawing-dock-collapse의 펼침·접힘 지연 확인(합 10.8초)이다. 둘 다 시간 자체를 확인하는 시험이다.
- 앱을 띄우는 비용: 시험당 Navigate 평균 1.3번, Navigate 합 108초(4.6%), Before Hooks 32초(1.4%). 시험마다 새 context를 쓰지만 이것이 지배적이지는 않다.
- 나머지는 시험 본문의 `expect` 재시도(42%), 클릭(10%), 마우스(4%)로 시험이 확인하는 동작 그 자체다.
- 준비 단계(의존성·WASM·타입·UI 빌드)는 실행당 약 2초다(e2e-time 보고서 2절).

## 부하에서만 흔들리는 시험과의 겹침

부하가 높은 실행에서만 실패한 시험은 두 종류로 나뉜다.

| 종류 | 시험 | 부하 없을 때 최대 → 부하에서 | 실패 메시지 |
|---|---|---|---|
| 긴 시험이 시험 제한 90초를 넘김 | drawing-modes:120 | 19.6초 → 96초 | Test timeout of 90000ms |
| | drawing-tools-all:268 | 24.3초 → 96초 | Test timeout of 90000ms |
| | drawing-engine:231 | 18.0초 → 102초 | Test timeout of 90000ms |
| 시간이 짧은데 멈추거나 단언이 경합 | financial-consistency:143 | 7.7초 → 96초(제한 초과) | Test timeout of 90000ms |
| | drawing-tools-all:112, drawing-tools-measure:126 | 10.9·9.2초 → 57·54초 | "다시 보이면 그림이 돌아온다" |
| | win-journey:386·451, win-canvas:64, day-separators:136, win-link:46, win-manage:212, drawing-pinned-dock:71 | 2~8초 → 14~19초 | `toEqual`·`toBe`·`toBeAttached` 단언 |

첫째 종류는 무거운 시험 상위 목록과 같은 시험이고, 시험이 길어서 터진다. 이 플랜에서 함께 다룬다(작업 `e2e-split-long`). 둘째 종류는 시험 길이로 설명되지 않는 경합이나 멈춤이라 재현으로 원인을 찾아야 하므로 이 플랜에서 다루지 않는다(아래 "사용자가 정해야 하는 결정" 2).

## 확정된 결정

- 시험이 확인하는 제품 동작은 줄이지 않는다. 시험을 지우거나 `skip`하지 않는다.
- chute 범인 찾기 재확인 단축은 chute 저장소의 post-recheck 플랜이 맡는다.
- `chute.toml`을 고치는 변경은 사람 승인이 필요하므로 이 플랜의 작업에 넣지 않는다.

## 스스로 정한 결정과 이유

1. **실패 스크린샷을 끈다(`screenshot: "off"`).** Playwright의 스크린샷 모드는 `off`가 아니면 모두 context를 닫을 때 임시 촬영을 한다(`on-first-failure`도 첫 시도에서 찍는다). 그래서 5초 대기를 없애는 설정은 `off`뿐이다. 실패 증거는 `trace: "retain-on-failure"`가 남기고, trace에는 동작마다의 화면과 DOM 스냅숏이 들어 있다. `scripts/web.py`, `scripts/evidence.py`, chute 설정, 문서 가운데 실패 스크린샷 파일을 읽는 곳은 없다.
2. **`fullyParallel: true`로 파일 안의 시험도 나눠 돌린다.** 시험마다 `harness.ts`의 `scenario`가 새 문서 상태를 만들고 context도 새로 열기 때문에 시험끼리 상태를 공유하지 않는 구조다. 저장소에 `beforeAll`·`afterAll`·`serial` 모드가 없다. 작업자는 모듈 수준의 바뀌는 변수 같은 숨은 공유가 없는지 확인한다.
3. **5초 대기를 먼저 없애고 그다음 배분을 바꾼다고 묶지 않는다.** 두 변경은 같은 설정 파일의 다른 줄이고 효과도 따로 잴 수 있어 병렬로 둔다.
4. **긴 반복 시험 셋은 같은 단언을 그룹별 시험으로 나눈다.** drawing-tools-all은 앞 작업(PR #406)이 "모든 도구" 시험을 같은 방식으로 나눴다. 나눈 뒤에도 도구 36개가 빠짐없이 한 번씩 확인되는지를 시험으로 고정한 그 방식을 따른다.
5. **고정 대기는 고치지 않는다.** 합이 58초(2.5%)로 작고, 큰 것은 "몇 초 안에 일어나지 않는다"를 보는 시험이라 시계를 바꾸면 확인하는 내용이 달라진다.
6. **worker 수는 이 플랜에서 바꾸지 않는다.** `--workers=6`은 `chute.toml`에 있고, 부하가 높을 때는 늘리면 해롭다(e2e-time 보고서 3절).

## 작업

| 작업 | 고치는 곳 | 프로필·방식 | 방식의 이유 |
|---|---|---|---|
| `e2e-shot-off` | `web/playwright.config.ts`의 `screenshot` 한 줄 | minor-fix · basic | 시험 설정 한 줄이고 제품 코드를 건드리지 않는다 |
| `e2e-fully-parallel` | `web/playwright.config.ts`에 `fullyParallel` 한 줄 | minor-fix · basic | 시험 실행 설정만 바꾼다. 시험 독립성은 성공 조건의 반복 실행으로 확인한다 |
| `e2e-split-long` | `web/e2e/drawing-modes.spec.ts`, `drawing-engine.spec.ts`, `drawing-tools-all.spec.ts`의 긴 시험 셋 | implementer · basic | 시험만 고친다 |

세 작업은 모두 병렬이다. `e2e-shot-off`와 `e2e-fully-parallel`은 같은 파일의 다른 줄에 한 줄씩 더하므로 두 지시서 모두 그 파일을 최소로 고치라고 적었다. `e2e-split-long`은 다른 파일만 고친다.

다른 작업과 겹치지 않게 다음 파일은 세 작업 모두 고치지 않는다: float-content-fix(t2gc)가 고치는 `float-content.spec.ts`·`system-settings.spec.ts`·`win-shell.spec.ts`, watch-head가 고친 `win-journey.spec.ts`·`watchlist-groups.spec.ts`, ui-login이 고치는 `fixtures/scenario.ts`·`account-login.spec.ts`.

## 예상 효과

기준 세 번의 시험별 시간으로 흉내 낸 Playwright 단계 시간(초)이다. "5초 대기 없앰"은 After Hooks가 4초를 넘은 시험에서 그 시간을 뺀 값이다.

| 설정 | worker 6 | 줄어드는 비율 |
|---|---|---|
| 지금 | 479~506 | |
| `e2e-shot-off`만 | 385~428 | 16~19% |
| `e2e-fully-parallel`만 | 391~422 | 17~18% |
| 둘 다 | 309~351 | 31~35% (8.0~8.4분 → 5.2~5.9분) |

- 부하가 있을 때는 5초 대기에 걸리는 시험이 더 많았다(125개, 636초). `e2e-shot-off`의 효과는 부하에서 더 크다.
- `e2e-split-long`은 시간 합을 줄이지 않는다(나눈 시험마다 앱을 새로 열어 몇 초 늘 수 있다). 가장 긴 시험이 19~24초에서 그룹 하나 분량으로 줄어, 부하로 3~5배 느려져도 90초 제한 안에 남게 하는 것이 목적이다. 흔들림 목록 첫째 종류 셋이 대상이다.
- 효과는 세 작업이 머지된 뒤 chute 머지 뒤 검사의 manifest `steps.playwright.elapsed_seconds`와 HTML 보고서로 확인한다. 부하와 섞이지 않게 같은 시각의 `sar -q`의 ldavg-1이 10 아래인 실행끼리 비교한다.

## 범위 밖

- chute 쪽 개선(범인 찾기 재확인, 무거운 작업과의 동시 실행 제한, 우선순위). post-recheck 플랜과 e2e-time 보고서 5절 a·b가 맡는다.
- 흔들림 둘째 종류(위 표)의 원인 수정.
- 고정 대기 바꾸기, `retries` 켜기, 시험 제한(90초)·`expect` 제한(15초) 늘리기.
- 위에 적은 다른 작업이 고치는 파일.

## 사용자가 정해야 하는 결정

1. **worker 수를 늘릴지.** `chute.toml`의 `--workers=6`을 바꾸려면 사람 승인이 필요하다. 세 작업 뒤 흉내 값은 worker 8에서 232~266초, worker 12에서 156~202초다. 이 값은 CPU 경합을 넣지 않은 하한이라 실제로는 더 길고, 부하가 높을 때는 오히려 느려진다. chute의 부하 제한(e2e-time 보고서 5절 a)과 함께 정하는 것을 권한다.
2. **흔들림 둘째 종류를 따로 고칠지.** financial-consistency:143(7.7초 시험이 90초를 넘겨 멈춤), drawing-tools-all:112·drawing-tools-measure:126("다시 보이면 그림이 돌아온다"), win-journey:386·451, win-canvas:64, day-separators:136, win-link:46, win-manage:212, drawing-pinned-dock:71. 앞선 흔들림 작업처럼 부하를 건 `--repeat-each` 재현으로 원인을 찾는 별도 플랜이 맞다. win-journey는 watch-head가 고친 파일이라 그 PR 뒤에 해야 한다.
3. **실패 스크린샷을 끄는 것에 동의하는지.** 위 "스스로 정한 결정" 1의 이유로 끄기로 했다. trace와 별도로 실패 PNG가 꼭 필요하면, `harness.ts`의 자동 fixture가 실패한 시험에서만 직접 찍게 하는 작업을 하나 더한다(`ui-login`이 `fixtures/scenario.ts`를 고치는 중이라 그 뒤에).
