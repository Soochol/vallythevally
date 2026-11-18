# e2e 한 실행의 동시 브라우저 수를 6개로 묶는다

- 작성일: 2026-11-18
- 승인 시점의 기록이며 구현 중 바뀐 것은 반영하지 않는다.

## 사용자가 풀려는 문제

이 PC는 논리 코어가 32개다. 2026-11-18 17:58에 load average가 50, CPU가 96%까지 올랐다. Playwright e2e의 headless Chrome 렌더러 약 19개가 각자 CPU 100%를 쓴 탓이다. 차트를 소프트웨어로 그리기 때문에 렌더러 하나가 코어 하나를 다 쓴다.

- chute 머지 뒤 검사: `chute.toml`의 `web.py e2e --workers=6`로 6개
- 다른 탭의 작업자 `e2e-drawing-shot`: `web.py e2e --repeat-each=6 --workers=12 --grep …`로 12개

`scripts/web.py`(215~216행)는 `--workers`가 없을 때만 기본값 2를 넣는다. 값을 주면 상한 없이 그대로 넘긴다. 사용자는 한 번에 뜨는 브라우저 수에 상한을 두려 한다. 검증(시험 목록)은 줄이지 않고 동시에 도는 수만 줄인다.

## 확정된 결정

- `web.py e2e`는 받은 `--workers`(`--workers=N`, `--workers N`, `-j N`, `-jN`)를 상한으로 줄이고, 줄였다는 줄을 하나 출력한다.
- `docs/e2e-tests.md`, `docs/web-checks.md`의 예시를 상한 안의 값으로 맞춘다.
- `web.py`의 인자 처리 시험에 상한을 넘는 경우를 더한다.
- 시험 목록과 검증 단계는 줄이지 않는다.

## 스스로 정한 결정과 이유

- **상한은 6이다.** `chute.toml`의 머지 뒤 검사가 쓰는 값과 같다. 머지 뒤 검사가 지금처럼 돌고, 작업자가 손으로 돌리는 실행도 그보다 무겁지 않다. 6개 실행 둘이 겹쳐도 렌더러는 12개라서 코어 32개 안에 든다.
- **`web.py`와 `playwright.config.ts`의 project `workers` 두 곳에서 막는다.**
  - Playwright 1.65는 CLI의 `--workers`가 설정 최상위의 `workers`를 덮는다(`lib/common/index.js`의 `takeFirst(configCLIOverrides.workers, userConfig.workers, "50%")`). 그래서 최상위 `workers`로는 상한을 둘 수 없다.
  - project의 `workers`(`projects[].workers`)는 CLI가 덮지 않는다. dispatcher가 project별로 동시에 도는 작업 수를 이 값으로 묶는다(`_workerLimitPerProjectId`, `_findFirstJobToRun`). 이 저장소에는 `chromium` project 하나뿐이다. 그래서 `chromium` project에 `workers: 6`을 적으면 `web.py`를 거치든, `pnpm exec playwright test`나 `node …/playwright/cli.js test`를 직접 부르든 동시에 도는 시험이 6개를 넘지 않는다.
  - `web.py`에서도 줄이는 이유: 직접 부르는 길에서는 Playwright가 "Running … using 12 workers"를 그대로 출력하고, 남는 worker 자리에도 프로세스가 뜰 수 있다. `web.py`가 먼저 줄이면 출력과 manifest(`results.playwright_output`)에 실제로 쓴 값이 남고, 줄였다는 줄로 작업자가 알 수 있다.
  - 두 곳의 6이 따로 놀지 않도록 `scripts/test-web.py`에 두 값이 같은지 보는 시험을 둔다.
- **`AGENTS.md`에 "e2e는 web.py로만 돌린다" 규칙은 넣지 않는다.** project `workers`가 모든 길을 막기 때문이다. 직접 실행 경로는 `docs/web-checks.md`가 이미 CI용으로 설명하고 있다.
- **작업자가 직접 Playwright를 불렀는지 확인했다.** `e2e-drawing-shot` 작업자의 세션 기록을 보면 `--workers=12`와 `--workers=8` 실행 모두 `python3 scripts/web.py e2e …`를 거쳤다. 다만 예전 세션 몇 곳(`feat-75`, `feat-66`, review 세션 등)은 `./node_modules/.bin/playwright test … --workers=6`처럼 직접 불렀다. 그래서 config 쪽 상한도 필요하다.
- **퍼센트(`--workers=50%`)는 Playwright와 같은 방식으로 계산해 비교한다.** `max(1, floor(os.cpu_count() × p / 100))`를 구해 6보다 크면 `--workers=6`으로 바꾼다. 이 PC에서 50%는 16이므로 6으로 줄어든다. 6 이하면 받은 값을 그대로 둔다.
- **`web.py`가 넘기는 worker 인수는 `--workers=<값>` 하나로 정리한다.** 같은 옵션이 여러 번 오면 Playwright(commander)는 마지막 값을 쓰므로 `web.py`도 마지막 값을 기준으로 삼는다. 인수가 없으면 지금처럼 `--workers=2`를 넣는다. 수나 퍼센트로 읽을 수 없는 값(`--workers=abc`, 값이 빠진 `--workers`)은 고치지 않고 넘겨 Playwright가 오류를 내게 한다. 오류 문구를 `web.py`가 따로 만들지 않는다.
- **문서 예시는 이미 상한 안이다.** `docs/e2e-tests.md` 67행 `--repeat-each=20 --workers=6`, `docs/web-checks.md` 18행 `--workers=3`, 42행 `--workers=6` 모두 6 이하다. 예시 값은 바꾸지 않고, `docs/web-checks.md` 33행의 "기본 worker는 2이며 Playwright 인수로 바꿀 수 있다" 곁에 상한 6과 두 겹으로 막는 방식을, `docs/e2e-tests.md` 70행 근처에 `--workers`가 6을 넘으면 줄어든다는 것을 적는다.
- **작업은 하나, PR 하나다.** 바뀌는 파일은 `scripts/web.py`, `scripts/test-web.py`, `web/playwright.config.ts`, `docs/web-checks.md`, `docs/e2e-tests.md`다. 상한값 하나를 세 곳(코드 두 곳과 문서)이 함께 써야 해서 나누지 않는다. 지금 열려 있는 PR과 다른 orch worktree의 변경 가운데 이 파일들을 건드리는 것은 없다(2026-11-18 18시 확인).

## 작업

| 작업 ID | 내용 | 방식 | 방식의 이유 | 순서 |
|---|---|---|---|---|
| `e2e-cap` | `web.py e2e`가 worker 수를 6으로 줄이고 줄였다는 줄을 출력한다. `playwright.config.ts`의 `chromium` project에 `workers: 6`을 둔다. 시험을 더하고 문서를 맞춘다 | `basic` (`minor-fix`) | 인수 처리, 설정 한 줄, 시험, 문서만 바꾼다. 머지 뒤 검사는 이미 6이라 검증 판정과 시험 목록은 그대로다 | 단독 |

## 범위 밖

- 여러 실행 사이의 상한(PC 전체 세마포어나 잠금). 이번에는 실행마다 6개로 묶는다. 동시에 실행이 둘이면 12개, 셋이면 18개까지 뜰 수 있다.
- `chute.toml`의 머지 뒤 검사 값(`--workers=6`)과 `post_verify_interval`.
- e2e 시험 자체와 시험 목록.

## 사용자가 정해야 하는 결정

- **여러 e2e 실행이 겹칠 때의 전체 상한이 필요한가.** 오늘 사고(6+12)는 이번 작업 뒤에 6+6=12로 줄어든다. 작업자 여러 명과 머지 뒤 검사가 한꺼번에 돌면 그래도 늘어난다. 필요하면 `web.py e2e`가 PC 전체 슬롯 잠금을 잡게 하는 후속 작업을 따로 연다.
- 검증을 약하게 하는 변경은 없다. 동시 수를 12로 주던 손 실행은 더 오래 걸린다.
