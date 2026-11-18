# `cargo test` 실행 스레드 상한

작성일: 2026-11-18. 승인 시점의 기록이며 구현 중 바뀐 것은 반영하지 않는다.

## 풀려는 문제

이 PC는 nproc 32다. 2026-11-18 load average가 15분 평균 160까지 올랐다. chute는 PC 전체에서 검증을 최대 3개 동시에 돌리고, 작업자 worktree도 같은 PC에서 시험을 돌린다. `scripts/dev.py`는 컴파일을 `CARGO_BUILD_JOBS=4`와 컴파일 잠금으로 묶지만, `run_cargo`가 `--no-run` 뒤 잠금 밖에서 시험을 실행할 때는 상한이 없다. libtest 기본값은 코어 수라서 `cargo test` 하나가 시험을 32개씩 동시에 돌린다. chute의 collector-test, account-server-test, setup-test, server-test 단계와 작업자의 `dev.py cargo test`가 모두 해당한다.

## 확정된 결정

- `dev.py`가 띄우는 `cargo test` 실행의 시험 스레드를 기본 8로 묶는다.
- 사용자가 준 값은 존중한다. 환경에 `RUST_TEST_THREADS`가 있으면 그대로 두고, `-- --test-threads=N`은 libtest가 환경변수보다 우선한다.
- 줄인 스레드로 시험이 실패하거나 시간 제한에 걸리지 않는지 실제로 돌려 확인하고 시간 변화를 보고한다.
- e2e `--workers=6`은 범위 밖이다.

## 스스로 정한 결정

- **값은 고정 8.** chute 검증 3개가 동시에 돌면 24, 작업자 하나가 더해져도 32 안팎이라 코어 수를 크게 넘지 않는다. 코어 수에서 계산하는 방식은 이 PC에서 같은 결과를 내면서 규칙만 늘리므로 쓰지 않는다. 코어가 8보다 적은 PC에서는 지금(코어 수)보다 동시 시험이 몇 개 늘지만, 그런 PC는 이 저장소의 검증 PC가 아니고 시험 결과는 같다.
- **시험 실행 단계에만 넣는다.** `run_cargo`가 `--no-run` 뒤 잠금 밖에서 실행하는 명령의 환경에 `RUST_TEST_THREADS`가 없을 때만 `8`을 넣는다. 컴파일 단계와 `build`·`check`·`clippy`는 그대로 둔다. 실행 파일 캐시 키(`fingerprint`)는 사용자 환경(`os.environ`)에서 계산하므로 도구가 넣는 기본값은 키를 바꾸지 않는다. `scripts/dev.py` 자체가 키 입력이라 병합 뒤 캐시가 한 번 새로 만들어지는 것은 다른 `dev.py` 수정과 같다.
- **측정은 같은 빌드에서 `RUST_TEST_THREADS=32`와 기본값을 비교한다.** 사용자 값을 존중하므로 `RUST_TEST_THREADS=32`가 지금 동작(코어 수 32)과 같다. 같은 트리·같은 실행 파일에서 스레드 수만 바꿔 비교할 수 있다.
- **검증을 약하게 하지 않는다.** 시험 목록, 시험 필터, `#[ignore]`, chute 단계 명령과 시간 제한은 그대로다. 같은 시험을 동시에 덜 돌릴 뿐이다.

## 작업

| 작업 | 방식 | 이유 |
|---|---|---|
| `test-threads` | `basic`, `minor-fix` | `dev.py` 한 함수의 환경 기본값과 그 시험·문서 한 줄. 검증 판정, 잠금, 상태 저장 코드는 바꾸지 않는다 |

작업이 하나라 병렬·순차 관계는 없다.

## 범위 밖

- e2e `--workers=6`.
- 시험 안에서 만드는 tokio 런타임 등 시험 코드가 직접 띄우는 스레드.
- `CARGO_BUILD_JOBS`와 컴파일 잠금.
- `chute.toml`. `scripts/dev.py`는 cargo test 단계들의 `paths`에 없어서 이 PR의 병합 검사에서는 네 시험 단계가 돌지 않는다(`check`와 머지 뒤 e2e만 돈다). 그래서 작업자가 네 단계를 직접 돌려 확인한다.

## 사용자가 정해야 하는 결정

- 검증을 약하게 하는 변경은 없다.
- 선택: `scripts/dev.py`를 cargo test 단계들의 `paths`에 넣으면 `dev.py`를 고친 PR마다 Rust 시험 단계가 돈다. 검증을 늘리는 쪽이고 이번 범위에는 넣지 않았다.
