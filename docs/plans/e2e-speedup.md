# e2e 시간 줄이기 플랜 (e2e-audit 결과 구현)

작성일 2026-11-18. 승인 시점의 기록이며 구현 중 바뀐 것은 반영하지 않는다.

기준: `origin/main` 59834fae. 근거 보고서: `/home/dev/.claude/orch/reports/e2e-audit/e2e-audit.md`(저장소 밖, 읽기 전용. 3절 후보 표, 7절 추천 묶음). 보고서의 줄 번호는 9df69c27 기준이고, 59834fae까지 `web/e2e`에서 바뀐 것은 새 파일 `win-dock-junction.spec.ts` 하나라 그대로 맞는다.

## 사용자가 풀려는 문제

머지 뒤 e2e(`scripts/web.py e2e --workers=6`)의 Playwright 단계가 411~478초 걸린다. 벽시계는 시험 시간 합을 6으로 나눈 값과 같다. 그래서 시험 안에서 새는 시간을 줄이면 그만큼 벽시계가 준다. e2e-audit 조사는 검증을 약하게 하지 않고 시험 시간 합에서 약 247초(벽시계 약 41초)를 줄일 수 있다고 추정했다. 사용자는 그중 묶음 1·2·3·5·6을 골랐고, 머지 뒤 검사 슬롯의 `target/web-runs`가 1.5일 만에 96개 16GB로 늘어난 문제를 함께 풀기로 했다.

## 확정된 결정 (사용자)

- 묶음 1(A): 자동저장 확인 poll을 `harness.ts`의 helper로 모으고 촘촘한 간격을 준다.
- 묶음 2(B): `win-manage.spec.ts`의 재시도 5초·6초 실대기를 `page.clock`으로 건너뛴다.
- 묶음 3(C): `drawing-probe.ts`의 `expandDock` 안정 확인을 브라우저 안의 `requestAnimationFrame` 루프 한 번으로 옮긴다. 판정 기준은 같다.
- 묶음 5(H·I): 고정 `waitForTimeout`을 `page.clock`으로 건너뛴다. 가짜 시계로 같은 상태가 되지 않는 시험은 그대로 두고 보고서에 이유를 적는다.
- 묶음 6: 시험별 시간을 작은 JSON으로 남기고 chute 보고서 쪽에 보존되게 한다.
- `scripts/web.py`에 `target/web-runs` 보존 규칙을 넣는다. 값은 플래너가 정한다. 작업자 worktree의 web-runs에도 같은 규칙이 적용되는지 확인한다.
- 하지 않는 것: 묶음 4(D·E·F·G, 검증 약화 후보), worker 수 늘리기.
- 검증을 약하게 하지 않는다. 같은 값을 같은 제한 시간으로 확인하고, 검사를 빼거나 비교를 느슨하게 하지 않는다.
- 전후 측정은 `python3 scripts/web.py e2e --workers=1 e2e/<파일>.spec.ts`처럼 좁게 하고, 흔들림 확인 반복은 CPU throttle과 차례 반복(`--workers=1 --repeat-each=N`)으로 한다.

## 작업과 순서

| 작업 | 묶음 | 고칠 곳 | 방식 | 순서 |
|---|---|---|---|---|
| `save-poll` | 1(A) | `web/e2e/harness.ts`, 저장 확인 poll이 있는 spec 34개 이상, `docs/e2e-tests.md`(상태 기다리기 절) | basic: 시험 코드만 고친다 | 처음부터 |
| `dock-settle` | 3(C) | `web/e2e/drawing-probe.ts` | basic: 시험 helper만 고친다 | 처음부터 |
| `e2e-durations` | 6 | `web/e2e/budget-reporter.ts`, `web/playwright.config.ts`, `docs/e2e-tests.md`(시간 예산 절) | basic: 시험 보고 도구이고 판정을 바꾸지 않는다 | 처음부터 |
| `web-runs-keep` | 보존 규칙 | `scripts/web.py`, `scripts/test-web.py`, `docs/web-checks.md` | poteto: 파일을 지우는 코드이고, 동시에 도는 다른 실행의 폴더를 지우면 안 된다 | 처음부터 |
| `retry-clock` | 2(B) | `web/e2e/win-manage.spec.ts`, `web/e2e/rules-baseline.json` | basic: 시험 코드만 고친다 | `save-poll` 뒤 |
| `wait-clock` | 5(H·I) | `drawing-dock-collapse`, `setup-wizard`, `account-login`, `system-settings-kiwoom`, `chart-settings`의 spec, `web/e2e/rules-baseline.json` | basic: 시험 코드만 고친다 | `save-poll`, `retry-clock` 뒤 |

순차로 둔 이유:

- `retry-clock`은 `save-poll` 뒤에 둔다. `win-manage.spec.ts`에 저장 확인 poll이 10곳 있고, 재시도 poll(:226 등)도 시나리오 값을 읽는 같은 모양이라 두 작업이 같은 줄을 다시 짠다. 뒤 작업은 앞 작업의 helper를 쓴다.
- `wait-clock`은 `save-poll` 뒤에 둔다. `chart-settings.spec.ts`와 `drawing-dock-collapse.spec.ts`가 겹친다. 특히 `drawing-dock-collapse.spec.ts`는 poll(:286)과 고정 대기(:287)가 붙어 있다.
- `wait-clock`은 `retry-clock` 뒤에 둔다. 둘 다 `rules-baseline.json`의 개수를 낮춘다. 고칠 줄(`system-settings-kiwoom` 11번째 줄, `win-manage` 12번째 줄)이 붙어 있어 동시에 고치면 충돌한다. 가짜 시계와 `clockStart`가 맞물리는 방식을 `retry-clock`이 먼저 확인하므로 `wait-clock`이 그 결과를 쓴다.
- 나머지는 겹치는 파일이 없다. `save-poll`과 `e2e-durations`는 `docs/e2e-tests.md`의 서로 다른 절에 몇 줄씩 더하므로 병렬이고, 두 지시서에 최소 변경을 적었다. `dock-settle`은 `drawing-probe.ts`만 고치고, `save-poll`은 그 파일을 건드리지 않는다.

열린 PR #568(ladder-grid)이 `win-order-panels.spec.ts`를 고친다. 이 파일에는 저장 확인 poll이 하나 있어 `save-poll`과 겹칠 수 있다. 그래서 `save-poll` 지시서에 최신 main으로 rebase하고 줄을 최소로 고치라고 적었다.

## 스스로 정한 결정과 이유

### 저장 확인 poll (save-poll)

- 대상은 callback이 node 쪽 값만 읽는 `expect.poll`이다. node 쪽 값은 `scenario.documents`, `saved(scenario)` 같은 그 위의 helper, 그리고 요청 handler가 채운 배열·수다. page·locator를 읽는 poll은 대상이 아니다. 보고서가 1.7~2.1초 구간으로 찾은 140곳은 이 모양이다. 같은 모양인데 시간이 다른 poll도 함께 옮긴다. 메모리를 읽는 일이라 촘촘히 읽어도 비용이 없고, 확인 횟수만 는다.
- 간격은 `intervals: [50]`이다. 보고서는 100ms를 예로 들었다. 50ms이면 debounce 1초 뒤 첫 확인이 1.05초가 되고, 읽기 비용은 무시할 만하다. 첫 확인은 지금처럼 바로 한다.
- 제한 시간은 그대로다. 기본 15초이고, 명시한 `timeout`이 있으면 그 값을 넘긴다.

### 재시도·고정 대기를 가짜 시계로 (retry-clock, wait-clock)

- "N초 안에 일어나지 않는다"를 가짜 시계로 확인하면, 가상 시간을 넘긴 직후에 단언이 돌아 아직 닿지 않은 요청을 놓칠 수 있다. 그러면 아무것도 확인하지 않고 통과할 수 있다. 그래서 바꾼 "일어나지 않음" 단언마다 두 가지를 성공 조건에 넣었다. (1) 가상 시간은 원래 대기와 같은 길이 이상 넘긴다. (2) 앱을 임시로 바꿔(예: 재시도를 막는 조건을 지움) 그 일이 일어나게 하면 시험이 실패한다는 변조 확인을 하고, 명령과 결과를 PR 본문에 적는다. 변조는 커밋하지 않는다.
- `rules-baseline.json`의 개수는 0이 되어도 항목을 지우지 않고 0으로 적는다. `e2e_rules.py`는 0 항목을 받는다. 이웃 줄을 덜 건드려 충돌이 줄어든다.

### expandDock 안정 판정 (dock-settle)

- 지금의 판정은 "node에서 읽은 막대 `boundingBox()`가 직전 읽기와 같다"이다. 읽기 사이는 최소 30ms(간격 [30,30,60,100])에 왕복 시간을 더한 만큼이다. 브라우저 안 rAF 루프가 연속한 두 프레임(약 16ms)만 비교하면 안정을 보는 창이 짧아진다. 그래서 "모든 프레임에서 같은 사각형이 30ms 이상 이어진다"를 판정 기준으로 정했다. 지금 기준보다 약하지 않다. 매 프레임을 보므로 A→B→A처럼 30ms 안에 움직였다 돌아오는 경우도 잡는다.
- 끝내 멈추지 않으면 지금처럼 15초 안에 실패한다.

### 시험별 시간 기록 (e2e-durations)

- chute가 머지 뒤 검사에서 보존하는 것은 검증 명령의 출력 로그뿐이다(`~/.local/state/chute/repos/Soochol__vallythevally/reports/commit-*/post/verify/e2e.N.log`, commit 보고서는 chute 기본 30일 보존). 실행 폴더를 chute 보고서로 옮기는 기능은 chute에 없다. 그래서 다음 둘을 남긴다.
  1. 실행 폴더의 `results/durations.json`: 모든 시험의 파일·줄·제목 경로·상태·시간·worker·시작 시각.
  2. 같은 내용을 gzip한 뒤 base64로 바꾼 한 줄을 출력에 넣는다. 접두어는 `e2e-durations: `다. 이 줄이 chute 로그에 들어가 30일 남는다. 아래 보존 규칙이 실행 폴더를 지워도 기록은 남는다.
- 그 줄은 list reporter의 마지막 요약(실패 목록과 개수)보다 앞에 둔다. chute 반송 보고서는 로그의 마지막 16KB를 싣는다. 요약보다 뒤에 두면 실패 내용이 그 16KB에서 밀려난다. 대신 실패가 적어 요약이 짧으면, 그 16KB에 base64 줄의 끝부분이 섞인다.
- 한 줄은 시험 1000개 기준 128KB 이하로 한다. 압축하기 전 JSON은 약 350KB로 추정된다. 지금 e2e 로그가 약 200KB이므로 로그는 많아야 1.6배가 된다.
- 다른 방법도 있다. chute에 "검증 뒤 이 파일을 보고서 폴더로 옮긴다"는 기능을 더하는 것이다. 이번 플랜에서는 하지 않는다. 이 저장소 밖의 일이고, 지금 방법으로 사용자 요구를 채운다.

### web-runs 보존 규칙 (web-runs-keep)

- 정리 시점: `web.py`의 모든 동작(`wasm`, `check`, `e2e`, `doctor`, `live`)이 새 실행 폴더를 만들기 전에 한 번 정리한다. 규칙이 `web.py`에 있으므로 chute 슬롯(post, batch, preflight)과 작업자 worktree에 똑같이 적용된다.
- 대상: `target/web-runs` 바로 아래의 `<종류>-<고유값>` 폴더다. 심볼릭 링크, 파일, 다른 이름, `target/dev-runs`는 건드리지 않는다. `scripts/evidence.py`는 고치지 않는다. 고치면 Rust 검증 단계가 모두 돌고, `dev-runs`는 이번 요청 밖이다.
- 값: 종류마다 통과한 실행은 최근 5개, 실패한 실행은 최근 10개를 남긴다. 실패에는 중단된 실행이 들어가고, 6시간이 지난 `running`과 manifest가 없는 실행도 들어간다. 최근 순서는 manifest의 `started_at`으로 정하고, 없으면 폴더 수정 시각으로 정한다. 근거: post 슬롯 e2e 실행 하나가 평균 약 170MB다(16GB/96개). 그러면 e2e 폴더는 약 15개, 2.5GB 안팎으로 묶인다. 머지 뒤 검사가 하루 수십 번 돌아 날짜 기준은 개수 기준보다 덜 묶는다. 시험별 시간 이력은 위 chute 로그가 맡으므로 오래된 실행 폴더가 필요 없다. 실패는 원인을 보려고 다시 열 일이 많아 통과의 두 배를 남긴다.
- 보호: manifest가 `running`인데 6시간이 안 된 폴더, manifest가 없는데 6시간이 안 된 폴더는 지우지 않고 세지도 않는다. 같은 worktree에서 동시에 도는 다른 실행이 있을 수 있어서다. chute e2e의 제한 시간은 1800초이고 `live`는 최대 600초라, 6시간은 넉넉하다.
- 지우다 실패하면(권한, 다른 프로세스가 먼저 지움) `dev-web:` 경고 한 줄만 내고 실행은 계속한다. 정리 때문에 검사가 실패하지 않는다.
- post 슬롯에 지금 있는 16GB는 이 작업이 머지된 뒤 처음 도는 머지 뒤 검사가 정리한다. 작업자가 chute 슬롯을 직접 지우지 않는다.

### 측정과 흔들림 확인

- 전후 시간은 같은 base의 작업 worktree에서 고치기 전과 뒤에 같은 명령(`--workers=1`)으로 잰다. 파일이 많은 작업(`save-poll` 34개, `dock-settle` 29개)은 대표 파일 4개만 잰다. 통과는 고친 파일 전부를 한 번에 넘겨(기본 worker 2) 확인한다. 34개 파일 시험 합은 약 1240초라 `--workers=1`로 전후를 다 재면 40분이 넘는다.
- 흔들림 확인은 `env VALLY_E2E_CPU_THROTTLE=4 python3 scripts/web.py e2e --workers=1 --repeat-each=5 …`다. 같은 시험을 동시에 여러 벌 돌리지 않는다.

## 범위 밖

- 묶음 4(D `chart-readability` settle, E `drawing-dock-move` 안정 대기, F `win-journey` Tab 반복, G `financial-viewport` 휠 반복): 검증 약화 후보라 하지 않는다.
- worker 수 변경, `playwright.config.ts`의 timeout·expect 제한 변경.
- 자동저장 debounce 자체를 가짜 시계로 건너뛰기(보고서 A의 "더 줄이려면"): 사용자가 고른 묶음 1은 간격만 바꾼다.
- chute 고치기(보고서 폴더 산출물 보존 기능), `scripts/evidence.py`와 `target/dev-runs` 정리.
- 시험마다 드는 고정 비용(Navigate, Hooks): 보고서가 추천하지 않았다.

## 사용자가 정해야 하는 결정

- 없음. 검증을 약하게 하는 작업은 넣지 않았다. 다음은 플래너가 정했으니 다르게 원하면 알려 달라.
  - 보존 값(통과 5개, 실패 10개, 6시간 보호)
  - chute 로그에 넣는 압축 기록 한 줄(128KB 이하). 실패가 적은 반송 보고서의 로그 꼬리 16KB에 이 줄의 끝부분이 섞일 수 있다. 싫으면 chute에 산출물 보존 기능을 더해야 한다. 그 일은 chute 쪽 제안으로 따로 낸다.
- `wait-clock`에서 가짜 시계로 같은 상태가 되지 않아 그대로 둔 시험은 작업 보고서에 이유와 함께 남는다. 사용자가 정한 대로 그 시험은 바꾸지 않는다.
