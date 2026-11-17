# e2e 시험 작성 기준과 기계 검사 플랜

작성일 2026-11-17. 승인 시점의 기록이며 구현 중 바뀐 것은 반영하지 않는다.

기준: `origin/main` 593e3e9.

## 사용자가 풀려는 문제

사용자의 말(그대로): "테스트 만들 때 기준이 있어야 이런 문제가 안 생길 것 같은데". 오케스트레이터가 vallythevally e2e부터 문서 기준과 기계 검사를 함께 두자고 제안했고, 사용자가 "추천으로" 승인했다.

오늘(2026-11-17) 머지 뒤 e2e에서 겪은 문제는 시험을 쓰는 방식에서 나왔다(e2e-time 보고서 `/home/dev/.claude/orch/reports/e2e-time/e2e-time.md`, [무거운 e2e 플랜](e2e-heavy.md)).

- 한 시험이 도구 여러 개를 반복문으로 돌아, 부하 때 90초 제한을 넘겼다(drawing-tools-all:268, drawing-modes:120, drawing-engine:231). PR #447이 그룹별 시험과 빠짐없음 시험으로 나눴다.
- 시간 기반 단언과 짧은 `expect` 제한이 부하에서만 실패했다(drawing-tools-all:112, drawing-tools-measure:126, financial-consistency:143, win-journey:386·451, day-separators:136 등).
- `screenshot: "only-on-failure"`가 통과한 시험마다 5초를 기다렸다(PR #445가 껐다).
- 파일 단위 배분이 끝에 worker 하나만 남겼다. PR #446이 `fullyParallel: true`로 바꿔서 이제 시험끼리 상태를 공유하면 안 된다.
- 고정 대기 `waitForTimeout`이 합 58초이고, 대부분 "N초 안에 일어나지 않는다"를 보는 시험이다.

기준 문서만 두면 다음 작업자가 읽지 않아도 막을 방법이 없다. 그래서 자동으로 확인할 수 있는 규칙은 검사로 만들고, 지금 있는 시험이 걸리는 곳은 허용 목록에 두어 새 위반만 막는다.

## 근거로 쓴 기록

- 593e3e9의 머지 뒤 e2e(`e2e-trs16x5c`, 부하 낮음): 843개 통과, Playwright 5.8분. 30초를 넘는 시험 0개, 20초를 넘는 시험 1개(indicator-inspector:27, 21.1초).
- 그 전 d71d124의 실행(#447 전): drawing-tools-all:268 26.4초, drawing-modes:120 22.4초. 부하(ldavg 100~290)에서는 같은 시험이 3~5배 느려져 90초를 넘겼다(e2e-time 보고서 3절).
- `web/e2e`의 `waitForTimeout`은 11개 파일에 25곳이다(drawing-dock-collapse 13곳, win-manage 6초 두 곳 등). `beforeAll`·`afterAll`·`serial` 모드·모듈 수준 `let`/`var`·`test.setTimeout`·`test.slow`는 0곳이다.
- 진행 중인 다른 작업의 e2e 파일: watch-head(`win-journey.spec.ts`, `watchlist-groups.spec.ts`), ui-setup-wizard(`fixtures/scenario.ts`, 새 `setup-wizard.spec.ts`). 두 브랜치의 변경에는 아래 규칙에 걸리는 곳이 없다(작성 시점 확인).

## 확정된 결정

- vallythevally의 e2e부터 한다. chute Rust 시험 기준은 다음 차례의 별도 플랜이다.
- 문서 기준과 기계 검사를 함께 둔다. 기준 문서는 `AGENTS.md`가 가리킨다.
- 지금 있는 시험이 걸리는 규칙은 허용 목록을 두고 새 위반만 막는다.
- 기존 시험을 대량으로 고치지 않는다.

## 스스로 정한 결정과 이유

1. **기준은 새 문서 `docs/e2e-tests.md`에 둔다.** `docs/web-checks.md`는 도구를 돌리는 법(준비 단계, 산출물 경로, manifest)을 적은 문서라 시험을 쓰는 법까지 넣으면 길어지고 찾기 어렵다. `docs/web-checks.md`의 "시험 작성 시 주의사항" 세 줄은 새 문서로 옮기고 링크만 남긴다. `AGENTS.md`의 `## 개발 문서`에 "e2e 시험을 쓰거나 고치기 전 이 문서를 읽는다"는 한 줄을 더한다.

2. **기준 문서에 담는 내용.** 작업 `e2e-doc`이 아래를 실제 시험 예시와 함께 적는다.
   - 한 시험은 한 동작을 확인한다. 여러 대상(도구 36개 등)을 확인할 때 한 시험 안에서 반복문으로 돌지 않는다. `describe` 수준에서 그룹(대상 4개 이하)마다 `test`를 만들고, 그룹 목록을 합치면 전체 목록과 같다는 빠짐없음 시험을 둔다(PR #447의 `drawing-tools-all.spec.ts` 방식).
   - 시간 예산: 부하가 없을 때 시험 하나가 30초 이하다. 시험 제한 90초를 부하 때 측정한 배율(3배)로 나눈 값이다. 넘으면 위 방식으로 나눈다. 반대로 시험마다 새 context와 앱을 여는 비용(Navigate·Before Hooks 합이 시험당 약 0.2초, e2e-heavy 3·4절)이 있으므로 몇 초짜리 시험을 단언 하나씩으로 쪼개지 않는다.
   - 시간 대신 상태·이벤트를 기다린다: web-first 단언(`expect(locator).toHave…`), `expect.poll`, `page.waitForResponse`, `scenario.hold/reply`, 앱이 내놓는 `data-*` 속성. `expect` 제한을 기본(15초)보다 짧게 두지 않는다. 바깥 `toPass`가 다시 시도하는 안쪽 한 번의 짧은 제한만 예외다.
   - 고정 대기는 "N초 안에 일어나지 않는다"를 볼 때만 쓴다. 먼저 `clockStart`와 `page.clock`으로 가상 시간을 넘기는 방법을 쓰고, 실제 시간이 필요할 때만 `harness.ts`의 `fixedWait(page, ms, 이유)`를 쓴다.
   - 시험은 서로 독립이다(`fullyParallel`). 상태는 `scenario` fixture가 시험마다 새로 만든다. `beforeAll`·`afterAll`·`serial` 모드·모듈 수준의 바뀌는 변수를 쓰지 않는다.
   - `retries`는 0이다. 흔들리는 시험은 다시 시도로 덮지 않고 고친다.
   - 시간에 민감한 새 시험(대기·애니메이션·실시간 프레임·늦은 응답)은 부하를 흉내 내 반복으로 확인하고 결과를 PR 본문에 적는다: `env VALLY_E2E_CPU_THROTTLE=4 python3 scripts/web.py e2e --repeat-each=20 --workers=6 e2e/<파일>.spec.ts:<줄>`.
   - 기계 검사 표: 무엇을, 어디서, 언제 확인하고, 허용 목록이 어디 있는지.

3. **정적 규칙은 `scripts/web.py check`에서 돌린다(작업 `e2e-rules`).** `check`는 chute batch `[[verify]] check`로 모든 PR의 머지 전에 돈다(`paths` 없음). 그래서 `chute.toml`을 고치지 않아도 머지 전 검사가 되고, 사람 승인도 필요 없다. 머지 뒤 e2e에 넣으면 이미 main에 들어간 뒤라 늦고, lint 도구를 새로 들이면 의존성이 는다. 검사는 `web/e2e` 아래 `.ts` 파일을 읽는 Python 모듈 `scripts/e2e_rules.py`로 만들고 `check`의 첫 단계로 둔다. 설치·빌드 전에 1초 안에 끝난다.

4. **정적 규칙은 다섯이다.** 모두 정규식으로 읽을 수 있고 지금 저장소에서 오탐 없이 맞는 것만 골랐다.
   - `waitForTimeout(`은 `harness.ts` 밖에서 쓰지 않는다(허용 목록: 지금 25곳).
   - `serial` 모드(`describe.serial`, `mode: "serial"`)를 쓰지 않는다.
   - `beforeAll`·`afterAll`을 쓰지 않는다.
   - spec 파일의 모듈 수준 `let`·`var`를 쓰지 않는다.
   - `test.setTimeout`·`test.slow`·`describe.configure`의 `timeout`으로 시험 제한을 늘리지 않는다. 예산을 넘는 시험은 나눈다.

   반복문 안의 여러 대상, 짧은 `expect` 제한은 정규식으로 가려낼 수 없어(PR #447 전의 반복문과 `toPass` 안의 정당한 짧은 제한이 같은 모양이다) 문서 기준과 아래 시간 예산 보고에 맡긴다.

5. **고정 대기의 이유는 주석이 아니라 인수로 적는다.** 저장소 규칙이 새 코드에 주석 줄을 쓰지 말라고 한다. `harness.ts`에 `fixedWait(page, ms, reason)`을 두고, 이유가 비면 시험을 실패시키며, 이유와 시간을 시험 annotation(`fixed-wait`)으로 남겨 HTML 보고서에서 보이게 한다. 검사는 raw `waitForTimeout`만 찾으면 된다.

6. **허용 목록은 파일별 개수이고 양쪽으로 맞춘다.** `web/e2e/rules-baseline.json`에 규칙별·파일별 개수를 적는다. 개수가 늘면 실패하고 "상태를 기다리거나 `fixedWait`을 쓰라"는 고칠 방법을 출력한다. 개수가 줄어도 실패하고 허용 목록을 낮추라고 출력한다. 줄어든 자리가 다시 차는 것을 막기 위해서다. 줄 번호가 아니라 개수라서 다른 줄을 고쳐도 걸리지 않는다.

7. **시간 예산은 경고로 보고하고 실패시키지 않는다(작업 `e2e-budget`).** 시험 하나의 시간은 PC 부하에 따라 3~5배 달라진다(e2e-time 보고서 3절). 30초를 실패 조건으로 두면 부하 때 새 흔들림이 되고, 머지 뒤 검사에서는 chute의 범인 찾기를 부른다. 오늘 줄이려던 바로 그 문제다. 대신 Playwright 사용자 reporter `web/e2e/budget-reporter.ts`가 실행 끝에 예산을 넘은 시험을 오래 걸린 순서로 출력하고 `results/budget.json`에 남긴다. 종료 코드는 바꾸지 않는다. 출력 줄에 `✘`를 쓰지 않아 chute의 `failed` 정규식(`✘.*?› (e2e/\S+?\.spec\.ts:\d+):\d+ ›`)에 걸리지 않게 한다. 지금 부하가 낮을 때 30초를 넘는 시험이 없으므로 허용 목록은 두지 않는다. 시험 제한 90초는 그대로 마지막 방어선이다.

8. **부하 흉내는 Chromium CPU 제한으로 한다(작업 `e2e-budget`).** `harness.ts`의 `scenario` fixture가 환경변수 `VALLY_E2E_CPU_THROTTLE`(1 이상의 수)를 읽어 그 context에서 열리는 모든 페이지에 CDP `Emulation.setCPUThrottlingRate`를 건다. `scripts/web.py e2e`는 환경을 그대로 넘기므로 도구를 고칠 필요가 없다. 실제 부하는 시험 실행기와 정적 호스트도 느리게 하므로 완전히 같지는 않지만, 브라우저 안의 타이머·애니메이션·렌더 경합을 반복으로 재현하기에는 충분하다. `--repeat-each`와 worker 수 늘리기는 Playwright 인수로 이미 된다.

9. **작업을 셋으로 나누고 문서를 마지막에 둔다.** 기준 문서가 검사의 이름(`fixedWait`, `rules-baseline.json`, `VALLY_E2E_CPU_THROTTLE`, `budget.json`)을 적으므로 문서가 먼저 머지되면 없는 도구를 안내한다. 두 검사 작업은 서로의 결과를 쓰지 않는다.

## 작업

| 작업 | 고치는 곳 | 프로필·방식 | 방식의 이유 | 순서 |
|---|---|---|---|---|
| `e2e-rules` | 새 `scripts/e2e_rules.py`, `scripts/web.py`의 `check_web`, `scripts/test-web.py`, 새 `web/e2e/rules-baseline.json`, `web/e2e/harness.ts`에 `fixedWait` | implementer · poteto | 모든 PR의 머지 전 검증 판정(`[[verify]] check`)에 단계를 더한다 | 병렬 |
| `e2e-budget` | 새 `web/e2e/budget-reporter.ts`, `web/playwright.config.ts`의 `reporter`, `web/e2e/harness.ts`의 `scenario` fixture에 CPU 제한 | implementer · basic | 시험 도구만 바꾸고 종료 코드를 바꾸지 않는다. chute 정규식과 겹치지 않는지는 성공 조건으로 확인한다 | 병렬 |
| `e2e-doc` | 새 `docs/e2e-tests.md`, `AGENTS.md` 한 줄, `docs/web-checks.md`의 "시험 작성 시 주의사항" | minor-fix · basic | 문서만 바꾼다 | `e2e-rules`, `e2e-budget` 뒤 |

- `e2e-rules`와 `e2e-budget`은 둘 다 `web/e2e/harness.ts`에 몇 줄씩 더한다(앞은 새 함수 하나, 뒤는 `scenario` fixture 안 몇 줄). 같은 함수를 다시 짜지 않으므로 병렬로 두고, 두 지시서에 그 파일은 최소로 고치라고 적었다. 나머지 파일은 겹치지 않는다.
- `e2e-doc`은 두 작업이 만든 이름과 명령을 문서에 적으므로 둘 뒤다.
- 세 작업 모두 기존 spec 파일을 고치지 않는다. watch-head와 ui-setup-wizard가 고치는 `win-journey.spec.ts`, `watchlist-groups.spec.ts`, `fixtures/scenario.ts`, `setup-wizard.spec.ts`와 겹치지 않는다. `e2e-rules`가 먼저 머지된 뒤 ui-setup-wizard가 새 spec에 `waitForTimeout`을 더하면 그 PR의 `check`가 실패하고 고칠 방법을 알려 준다. 의도한 동작이다.

## 범위 밖

- 기존 시험 고치기: 고정 대기 25곳을 `page.clock`이나 `fixedWait`으로 옮기기, 부하에서만 흔들리는 시험(e2e-heavy의 둘째 종류) 고치기. 아래 결정 2의 후속 플랜으로 제안한다.
- 시험 제한 90초·`expect` 제한 15초·`retries`·worker 수 바꾸기, `chute.toml` 고치기.
- chute Rust 시험 기준(다음 플랜).
- 바뀐 파일로 관련 spec을 골라 주는 도구.

## 사용자가 정해야 하는 결정

1. **시간 예산을 실패로 올릴지.** 이 플랜은 경고만 한다(결정 7). 실패로 올리면 부하가 높은 때 예산 초과가 실패가 되고 머지 뒤 검사에서 범인 찾기가 돈다. 실패가 꼭 필요하면, 머지 뒤 검사가 아니라 작업자가 관련 spec을 직접 돌릴 때만 실패시키는 선택(`scripts/web.py e2e`에 인수를 하나 더한다)을 권한다.
2. **기존 시험을 고치는 후속 플랜을 둘지.** 대상: 고정 대기 25곳(가장 큰 것은 win-manage의 6초 두 곳으로 `page.clock`으로 바꿀 수 있는지 먼저 본다, drawing-dock-collapse 13곳), 부하에서만 흔들리는 시험(financial-consistency:143, drawing-tools-all:112, drawing-tools-measure:126, win-journey:386·451, day-separators:136 등). 고친 만큼 `rules-baseline.json`이 줄어든다. win-journey는 watch-head 머지 뒤에 해야 한다.
