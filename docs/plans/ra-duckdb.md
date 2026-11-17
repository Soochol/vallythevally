# rust-analyzer가 DuckDB를 소스부터 빌드하지 않게 하기 플랜

작성일 2026-11-17. 승인 시점의 기록이며 구현 중 바뀐 것은 반영하지 않는다.

기준: `origin/main` 529fff0.

## 사용자가 풀려는 문제

merge-speed 조사에서 PC 부하(32코어에서 부하 평균 137~204)의 원인이 chute 검증이 아니라 에이전트 worktree의 rust-analyzer로 드러났다. rust-analyzer가 `scripts/dev.py`를 거치지 않고 `cargo check --workspace`를 직접 돌려, 기본 기능 `bundled-duckdb`로 `libduckdb-sys`를 C++ 소스부터 빌드했다(`cc1plus` 32개). 이 부하 아래에서 e2e는 8.0분에서 10~16분으로, server-test는 136초에서 354초로 늘었고 e2e 시간 초과 실패도 늘었다.

평소 개발 빌드는 `scripts/dev.py`가 미리 빌드한 DuckDB(`DUCKDB_LIB_DIR`, `scripts/duckdb-prebuilt.json`), `--no-default-features`, `CARGO_BUILD_JOBS=4`, 공통 컴파일 잠금을 붙인다. rust-analyzer도 같은 길로 컴파일하게 만드는 것이 목표다.

사용자는 조사 보고서의 추천(안 A와 안 B)으로 진행하라고 했고, 그 뒤 안 A만 하기로 바꿨다(2026-11-17).

## 확정된 결정

- **안 A만 한다.** 저장소에 rust-analyzer 프로젝트 설정을 두어 build scripts와 check가 `scripts/dev.py cargo check ... --message-format=json`으로 돌게 한다.
- **안 B는 하지 않는다.** `.cargo/config.toml`에 `[build] jobs`를 더하지 않는다. A가 들어간 뒤 부하를 지켜보고 필요하면 그때 다시 정한다.
- `chute.toml`은 고치지 않는다.
- 확인: rust-analyzer가 뜰 때 `cc1plus`가 뜨지 않고, 미리 빌드한 DuckDB를 쓰며, 동시 컴파일이 4개 안쪽이다. 무거운 전체 빌드는 여러 번 돌리지 않는다.
- 작업은 하나이고 chute로 병합한다.

## 스스로 정한 결정과 이유

- **rust-analyzer 옵션만 바꾸지 않고 `dev.py`를 거친다.** `cargo.noDefaultFeatures`만 켜도 C++ 빌드는 사라진다. `libduckdb-sys`는 `bundled`이 없으면 링크 지시만 내고 C++을 컴파일하지 않는다. 그러나 환경이 `dev.py`와 달라진다. `libduckdb-sys`는 `DUCKDB_LIB_DIR`·`DUCKDB_STATIC`을, `cc`를 쓰는 의존성은 `CC`·`CXX`(dev.py가 ccache로 감싼다)를 `rerun-if-env-changed`로 지켜본다. 같은 `target`을 쓰는 rust-analyzer와 `dev.py cargo test`가 번갈아 돌 때마다 이 build script와 그 위 크레이트가 다시 컴파일된다. `dev.py`를 거치면 환경, 기능, `--locked`가 같아 서로의 산출물을 그대로 쓰고, 작업 수 4와 컴파일 잠금도 따라온다.
- **기계가 읽는 출력(`--message-format=json…`)에서는 `dev.py`가 cargo의 stdout을 손대지 않고 넘긴다.** 지금 `dev.py cargo`는 세 가지 점에서 rust-analyzer와 맞지 않는다.
  1. `say()`가 안내 문구("DuckDB 재사용", "컴파일 잠금 대기")를 stdout에 쓴다.
  2. `evidence.command`가 cargo의 stderr를 stdout에 합치고, 줄마다 `evidence.clean()`을 적용한다. `clean()`의 `token|secret|password\s*[:=]\s*[^\s,;]+`와 `authorization\s*[:=][^\r\n]*` 치환은 따옴표를 넘어 지우므로, 진단 span에 `password: String` 같은 코드가 있으면 JSON 줄이 깨지고 그 진단은 사라진다.
  3. `evidence.spawn`이 cargo를 새 세션(`start_new_session=True`)으로 띄운다. rust-analyzer가 앞선 check를 끝낼 때 자기 프로세스 그룹에 SIGKILL을 보내면 `dev.py`만 죽고 `flock`과 cargo는 살아남아, 컴파일 잠금과 `target` 잠금을 쥔 채 계속 돈다. 또 저장할 때마다 `target/dev-runs/`에 실행 기록 폴더가 하나씩 쌓인다.

  그래서 안내 문구는 stderr로 보내고, JSON 출력 실행은 실행 근거 기록(`evidence.Run`) 없이 표준 입출력을 물려받는 길로 돌게 한다. 구체적인 모양은 작업자가 정하되 위 세 조건을 시험으로 고정한다. `dev.py`의 사람용 출력과 chute 검증 명령의 동작은 그대로다.
- **설정 위치는 저장소 루트의 `rust-analyzer.toml`이다.** rust-analyzer 1.96(현재 툴체인)의 설정 스키마에 `cargo.buildScripts.overrideCommand`와 `check.overrideCommand`가 있다. 다만 프로젝트 `rust-analyzer.toml`에서 이 두 키가 적용되는지는 스키마만으로 알 수 없다. 작업자가 실제로 띄워 확인하고, 적용되지 않으면 저장소 밖 설정으로 돌리지 말고 막힌 점으로 보고한다.
- **Claude Code의 `rust-analyzer-lsp` 플러그인은 `rust-analyzer` 명령만 띄우고 초기화 설정을 넘기지 않는다**(`plugin.json`에 `command`와 확장자뿐이다). 그래서 rust-analyzer는 기본값과 프로젝트 `rust-analyzer.toml`을 읽는다. 플러그인 쪽에서 바꿀 것은 없다. 실제로 그렇게 도는지는 작업자가 확인한다.
- `dev.py`를 바꾸면 `dev.py`의 실행 파일 캐시 키와 `web.py`의 준비 지문이 한 번 바뀐다. 다음 빌드 한 번만 다시 컴파일하며 받아들인다.

## 작업

| 작업 | 방식 | 이유 |
|---|---|---|
| `ra-duckdb` | poteto | `dev.py`의 자식 프로세스 처리와 컴파일 잠금이 풀리는 조건을 바꾼다(동시성·프로세스·잠금) |

작업이 하나라 병렬·순차 관계는 없다.

## 범위 밖

- 안 B(`.cargo/config.toml`의 `[build] jobs`). 다시 정할 때까지 하지 않는다.
- `chute.toml`, 다른 개선안(e2e 재실행, nextest, workers 증가, gate 작업 수).
- 에이전트 머신 설정(사용자 수준 rust-analyzer 설정, 에이전트 세션에서 rust-analyzer 끄기).
- rust-analyzer 자체의 분석 스레드 CPU 사용.
- `--bundled` 경로와 배포용 release 빌드. 바꾸지 않는다.

## 사용자가 정해야 하는 결정

- 없음. 프로젝트 `rust-analyzer.toml`에서 override 설정이 적용되지 않는 것으로 드러나면, 사용자 수준 설정으로 할지 에이전트 세션에서 rust-analyzer를 끌지를 그때 정한다.
