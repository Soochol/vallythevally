# chute 검증 단계 `paths`에 스크립트 입력 넣기

작성일: 2026-11-18. 승인 시점의 기록이며 구현 중 바뀐 것은 반영하지 않는다.

## 풀려는 문제

`chute.toml`의 clippy, collector-test, account-server-test, setup-test, server-test 단계는 `run`이 `python3 scripts/dev.py cargo ...`인데 `paths`에 `scripts/dev.py`가 없다. 그래서 `dev.py`만 바꾼 PR(#544, `RUST_TEST_THREADS` 기본 8)은 batch에서 이 다섯 단계가 돌지 않았다. 바뀐 파일이 단계의 `paths`에 없으면 chute는 그 단계를 건너뛴다.

`dev.py`가 실행 중에 쓰는 파일은 `dev.py` 하나가 아니다.

- `scripts/evidence.py`: `dev.py`가 맨 위에서 `import evidence`로 불러온다.
- `scripts/duckdb-prebuilt.json`: `dev.py`의 `execute`가 명령마다 `load_pin`으로 읽고 `Cargo.lock`의 duckdb 버전과 맞는지 검사한다. 이 파일이 깨지거나 버전이 어긋나면 다섯 단계가 모두 실패한다.

머지 뒤 e2e 단계(`python3 scripts/web.py e2e`)의 `paths`에는 `scripts/web.py`, `scripts/dev.py`, `scripts/evidence.py`가 이미 있다. 빠진 것은 두 개다.

- `scripts/e2e_rules.py`: `web.py`가 맨 위에서 `import e2e_rules`로 불러온다.
- `scripts/duckdb-prebuilt.json`: e2e 준비(`prepare_dart`)가 `dev.py build --bin dart-smoke`를 돌리므로 위와 같은 이유로 읽힌다.

`check` 단계는 `paths`가 없어 늘 돌므로 빈틈이 없다.

## 확정된 결정

- `dev.py`로 도는 모든 단계의 `paths`에 `dev.py`와 `dev.py`가 import하는 스크립트 모듈을 넣는다.
- `scripts/web.py`로 도는 단계의 같은 빈틈도 함께 메운다.
- 검증을 넓히는 변경이다. 단계를 빼거나 명령, 시간 제한, `failed` 패턴을 바꾸지 않는다.
- `chute config-check`가 통과해야 한다.

## 스스로 정한 결정

- **`scripts/duckdb-prebuilt.json`도 넣는다.** 요청은 import하는 모듈을 말했지만, 이 파일은 `dev.py`가 모든 cargo 명령에서 읽고 검사하는 입력이라 바뀌면 다섯 단계의 결과가 달라질 수 있다. 빈틈을 메운다는 요청의 목적에 맞는다.
- **`doctor.py`와 `live.py`는 넣지 않는다.** `web.py`는 `doctor`, `live` 명령에서만 이 둘을 불러오고, chute 단계는 `check`와 `e2e`만 돌린다.
- **다섯 단계에 같은 세 경로를 넣는다.** 단계마다 실제로 쓰는 입력이 같다. account-server-test와 setup-test는 duckdb 라이브러리를 준비하지 않지만 `load_pin`은 여전히 돈다.
- **`chute.toml` 단계를 검사하는 시험은 새로 만들지 않는다.** 저장소에 `chute.toml`을 읽는 시험이 없다. 요청은 있으면 맞추라는 것이었다. 작업자는 지시서의 검사 명령으로 결과를 확인한다.
- **기존 서식을 따른다.** clippy와 setup-test는 한 줄 배열 그대로 두고 끝에 붙인다. 여러 줄 배열은 `.cargo/` 뒤에, e2e는 `scripts/evidence.py` 뒤에 붙인다.

## 작업

| 작업 | 방식 | 이유 |
|---|---|---|
| `dev-paths` | `basic`, `minor-fix` | `chute.toml` 설정 한 파일에 경로만 더한다. 검증 명령과 판정 코드는 바꾸지 않고 검증 범위를 넓히기만 한다 |

작업이 하나라 병렬·순차 관계는 없다. 이 플랜을 쓰는 시점에 `chute.toml`을 고치는 열린 PR은 없다. 다른 탭의 orch 작업이 같은 파일을 고칠 수 있으므로 지시서는 `chute.toml`을 최소로 바꾸라고 적는다.

## 범위 밖

- clippy와 setup-test의 `paths`에 `.cargo/`가 없는 것. 다른 cargo 단계에는 있다. `dev.py`가 `.cargo/` 설정을 읽으므로 같은 종류의 빈틈이지만 이번 요청은 스크립트 입력이다. 따로 고칠 수 있다.
- cargo 단계의 `paths`에 `rust-toolchain`, `rust-toolchain.toml`이 없는 것. 두 파일은 지금 저장소에 없다.
- `scripts/test-*.py` 시험. chute의 어느 단계도 이 시험들을 돌리지 않는다.
- `check` 단계. `paths`가 없어 늘 돈다.

## 사용자가 정해야 하는 결정

- 검증을 약하게 하는 변경은 없다.
- 범위 밖의 `.cargo/` 빈틈(clippy, setup-test)을 이 작업에 포함할지. 포함하지 않는 것으로 계획했다.
