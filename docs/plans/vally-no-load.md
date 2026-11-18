# 부하 재현은 그 실행 안에서만 한다

- 작성일: 2026-11-18
- 승인 시점의 기록이며 구현 중 바뀐 것은 반영하지 않는다.

## 사용자가 풀려는 문제

2026-11-18 18:33에 [flaky-tests 플랜](flaky-tests.md)의 `e2e-drawing-shot` 작업자가 고치기 전 재현을 하려고 `timeout 500 sh -c 'while :; do :; done'`을 66개 띄웠다. 코어 32개인 공용 PC 전체가 100%가 됐다. 같은 PC의 다른 작업자와 chute 머지 검증이 모두 느려졌고 다른 시험이 흔들렸다.

flaky-tests 플랜은 "부하 반복으로 재현"과 "고친 뒤 부하를 걸고 반복"을 요구했지만 부하를 무엇으로 걸지는 정하지 않았다. 사용자는 두 가지를 원한다. 부하·타이밍 재현은 결정적 방법이나 그 실행에만 거는 제한으로 하는 규칙을 문서에 둔다. 그리고 flaky-tests 플랜의 시험들이 PC 전체 부하에 기대지 않게 한다.

## 확정된 결정

- 부하·타이밍 재현은 지연 주입과 가짜 시계 같은 결정적 방법으로 한다. 예는 `fake.delay`, `VALLY_CLOCK_START`, `scenario.hold`, `page.clock`이다. 아니면 `VALLY_E2E_CPU_THROTTLE`처럼 그 실행에만 거는 제한을 쓴다.
- PC 전체에 인위적 부하를 걸지 않는다. 무한 루프와 stress 도구가 그 예다.
- 검증을 약하게 하지 않는다. 흔들림을 숨기려고 고정 대기를 늘리지 않는다.
- [flaky-tests 플랜](flaky-tests.md)은 승인 시점의 기록이라 고치지 않는다. 이 문서가 그 플랜의 부하 재현 수단을 정하는 후속 기록이다.

## flaky-tests 플랜의 부하 재현 수단(후속 기록)

flaky-tests 플랜의 "부하를 걸고 반복"은 다음 수단을 뜻하는 것으로 정한다.

- e2e는 `VALLY_E2E_CPU_THROTTLE`로 그 실행의 브라우저만 느리게 한다. 늦은 응답은 `scenario.hold`로, 시간은 `page.clock`으로 다룬다.
- Rust 서버 시험은 `fake.delay`로 응답을 늦추고, `VALLY_CLOCK_START`와 `clock().jump`로 시계를 옮긴다. 그 실행만 느리게 해야 하면 `taskset`으로 그 실행을 코어 몇 개에 묶는다.
- 이 수단으로 재현하지 못하면 부하를 키우지 않는다. 무엇을 시도했는지 보고하고 멈춘다.

네 작업을 점검했다(18:50 기준).

| 작업 | 상태 | 확인 단계가 PC 부하에 기대는가 | 처리 |
|---|---|---|---|
| `e2e-win-canvas` | 머지(PR #552) | 아니다. 재현과 확인 모두 `VALLY_E2E_CPU_THROTTLE=4`로 했다. 시험 코드는 저장값을 `expect.poll`로 기다린다 | 없음 |
| `e2e-financial-dock` | 머지(PR #551) | 아니다. 재현은 도크가 접히기를 기다리는 임시 단언으로 했고, 확인은 CPU throttle로 했다. 시험 코드는 `aria-pressed` 상태를 단언한다 | 없음 |
| `kiwoom-reissue` | 진행 중(다른 탭, PR 없음) | 지시서 성공 조건 4가 PC 부하다. "같은 시험 바이너리를 동시에 4개 돌린 상태로" 20번 돌리라고 했다. 브랜치의 시험 코드는 `fake.delay`와 `clock().jump`로 결정적이라 PC 부하에 기대지 않는다 | 이 플랜에 작업을 두지 않는다. 진행 중 브랜치는 건드리지 않는다. 성공 조건 4를 바꾸는 일은 [사용자가 정해야 하는 결정](#사용자가-정해야-하는-결정) 1이다 |
| `e2e-drawing-shot` | 막힘(코드 변경 없음) | 그렇다. 사건의 바쁜 루프가 이 작업에서 나왔다. 지시서가 "부하 반복에서 145행 실패"를 재현 근거로 요구했다. CPU throttle 4~6으로 재현되지 않자 작업자가 부하를 키웠다 | `e2e-drawing-repro` 작업이 결정적 재현으로 다시 맡는다. 다른 탭의 작업을 어떻게 할지는 결정 2다 |

`e2e-drawing-shot` 보고서(`/home/dev/.claude/orch/reports/e2e-drawing-shot/e2e-drawing-shot.md`)가 확인한 것:

- 기준 `shown`을 찍는 순간 `data-toggling`은 한 번도 켜져 있지 않았다(0/54, 0/36). 플랜의 도크 전환 가설은 근거가 없다.
- 같은 모양의 실패가 `drawing-tools-measure.spec.ts:218`(주봉)에도 있다. 도크와 무관한 공통 원인일 수 있다.

## 저장소 안의 부하 코드 점검

저장소 전체에서 무한 루프(`while :`, `while true`), `stress`/`stress-ng`, `yes >`, 바쁜 루프, 코어 수만큼 프로세스를 띄우는 코드를 찾았다. 대상은 `scripts/`, `web/e2e`, `crates/*/tests`, 셸·Python 파일이다.

- PC 전체 부하를 만드는 코드는 없다.
- `crates/server/tests/kiwoom_link.rs`의 `racing_connect_and_disconnect_on_threads_always_ends_disconnected`는 `std::hint::spin_loop`를 쓴다. 이 시험 스레드 하나가 상태가 바뀌기를 기다리고, 회차마다 0~195µs를 비운다. 연결과 끊기 사이의 경합 창을 회차마다 옮겨 재현하는 장치다. 600회를 다 돌아도 바쁜 대기는 0.1초 남짓이라 PC 전체 부하가 아니다. 바꾸지 않는다.
- `scripts/web.py`의 `os.cpu_count`는 e2e worker 수를 정하는 데만 쓴다. 상한은 6이다.

## 스스로 정한 결정과 이유

- **규칙을 AGENTS.md에도 한 줄 둔다.** AGENTS.md에는 시험 규칙 절이 따로 없다. 다만 "저장소 규칙" 목록에 "키움 시험은 주입한 합성 transport·세션을 사용한다"라는 시험 규칙이 이미 있다. AGENTS.md는 모든 작업자가 늘 읽는 유일한 문서다. `docs/e2e-tests.md`는 e2e를 고칠 때만 읽힌다. 그래서 목록에 한 줄을 두고 자세한 수단은 두 문서를 가리킨다.
- **Rust 쪽 규칙은 `docs/development-builds.md`의 "자동 시험" 절에 둔다.** 요청은 e2e 문서만 들었다. 그런데 `kiwoom-reissue` 지시서의 "바이너리 4개 동시 실행"이 보여 주듯 Rust 시험에도 같은 틈이 있다. Rust 빌드·시험 전에 읽는 문서가 그 파일이다.
- **그 실행에만 거는 Rust 제한은 `taskset`으로 정한다.** Rust 시험에는 `VALLY_E2E_CPU_THROTTLE` 같은 장치가 없다. `taskset -c 0-1`은 그 프로세스와 자식만 코어 두 개에 묶는다. 다른 작업의 코어를 빼앗지 않으면서 그 실행만 느려진다. 이미 컴파일된 시험을 돌릴 때 걸어야 컴파일까지 느려지지 않는다. 그러니 먼저 제한 없이 한 번 돌려 컴파일해 둔다. 새 환경변수나 `dev.py` 옵션은 만들지 않는다. 지금 필요한 것은 규칙이고, `taskset`이 이미 있다.
- **재현하지 못하면 멈추고 보고하라고 규칙에 적는다.** 이번 사건은 throttle로 재현되지 않자 작업자가 부하를 키우면서 났다. 그다음 할 일이 비어 있었다.
- **같은 시험을 여러 벌 동시에 돌리는 것도 PC 전체 부하로 본다.** Rust의 "바이너리 4개 동시 실행"이 그 예다. `--workers`처럼 한 실행 안의 병렬은 이미 상한(e2e 6, `RUST_TEST_THREADS` 기본 8)이 있어서 따로 막지 않는다.
- **`e2e-drawing-repro`는 지연 주입으로 원인을 찾는다.** 실패 모양을 보면, 15초 동안 같아지지 않는 것은 `shown`을 찍은 뒤 그림이 바뀌어 돌아오지 않는다는 뜻이다. 부하 때만 늦게 도착하는 입력이 있다면 `scenario.hold`로 그 입력을 `shown` 뒤까지 붙잡아 같은 실패를 결정적으로 낼 수 있다. 입력은 응답, 실시간 프레임, 글꼴, 목록과 차트 사이의 호버·선택 연동이다. 이 방법은 부하에 기대지 않는다. 같은 모양의 `drawing-tools-measure.spec.ts:218`도 같은 주입으로 확인한다.
- **두 작업은 병렬이다.** `no-load-rule`은 `AGENTS.md`, `docs/e2e-tests.md`, `docs/development-builds.md`만 고친다. `e2e-drawing-repro`는 `web/e2e/drawing-tools-*.spec.ts`, `web/e2e/drawing-probe.ts`, 필요하면 `web/src`를 고친다. 겹치는 파일이 없다. `e2e-drawing-repro`가 따를 규칙은 지시서에 직접 적었으니 문서 작업을 기다리지 않는다.

## 작업

| 작업 ID | 내용 | 방식 | 방식의 이유 | 순서 |
|---|---|---|---|---|
| `no-load-rule` | AGENTS.md, `docs/e2e-tests.md`, `docs/development-builds.md`에 부하 재현 규칙을 적는다 | `basic` (`minor-fix`) | 문서만 고친다 | 병렬 |
| `e2e-drawing-repro` | `drawing-tools-all.spec.ts` 145행 실패를 지연 주입으로 결정적으로 재현하고 원인을 고친다. 재현하지 못하면 코드를 바꾸지 않고 보고한다 | `basic` (`implementer`) | 시험을 고치고, 제품 쪽이면 작은 화면 경합을 고친다. 원인을 찾는 단계가 있어 `minor-fix`보다 넓다 | 병렬 |

## 범위 밖

- flaky-tests 플랜 문서(`docs/plans/flaky-tests.md`) 수정
- 진행 중인 `kiwoom-reissue` 브랜치와 그 지시서
- `drawing-tools-all.spec.ts:473`의 흔들림(chute `flaky` 기록 1건). 145행과 다른 시험이다.
- `SLICE_SIZE`와 30초 예산 초과, 마스크 영역, 시험 제한 시간, `expect` 제한, worker 수, `chute.toml`의 검증 단계
- PC 부하를 기계적으로 막는 장치(프로세스 감시, cgroup 정책). 이 저장소가 아니라 작업 환경의 일이다.

## 사용자가 정해야 하는 결정

검증을 약하게 하는 작업(검증 단계 삭제, 시간 제한 증가, `paths` 축소)은 넣지 않았다. 대신 다른 탭의 진행 중 작업에 걸린 결정이 둘 있다.

1. **`kiwoom-reissue`의 성공 조건 4를 지금 바꿀지.** 권장은 바꾸는 것이다. 다른 탭 오케스트레이터가 작업자에게 다음처럼 바로잡아 보내면 된다. "바이너리 4개 동시 실행 대신, 한 번 컴파일한 뒤 `taskset -c 0-1 python3 scripts/dev.py cargo test -p server --test kiwoom_link`를 20번 돌려 실패 0을 보인다. 새 `fake.delay` 회귀 시험이 고치기 전에 실패하는 출력이 결정적 재현 근거다." 이미 동시 실행을 마쳤다면 그 결과는 PR에 남기되 다시 돌리지 않는다.
2. **다른 탭의 막힌 `e2e-drawing-shot`을 어떻게 할지.** 권장은 그 작업을 닫고 이 플랜의 `e2e-drawing-repro`가 맡는 것이다. 두 작업이 같은 파일을 동시에 고치면 안 된다. 다른 탭에서 이어 가려면 이 플랜에서 `e2e-drawing-repro`를 빼고, 그 작업자에게 이 문서의 재현 수단을 따르라고 보낸다.
