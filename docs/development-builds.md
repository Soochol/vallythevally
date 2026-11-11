# 개발 서버 빌드 재사용

로컬 개발에서는 Python 3.11 이상, Rust, `flock`과 C/C++ 컴파일러를 준비하고 저장소 루트에서 실행한다.

```sh
python3 scripts/dev.py build
```

이 명령은 앱 서버 실행 파일만 `target/dev/bin/vally-server`에 준비한다. 서버를 자동으로 실행하거나 키움에 접속하지 않는다. UI만 바뀌었거나 새 worktree의 Rust 빌드 입력이 같으면 실행 파일을 공유 캐시에서 각 worktree의 `target/dev/bin`으로 복원한다. Rust 입력이 바뀌었으면 Cargo를 실행하되 DuckDB는 준비된 라이브러리를 재사용한다. 새 worktree에서 Rust 중간 산출물이 없다면 Rust 의존성은 컴파일해야 한다. 복원 경로를 Cargo 산출물과 분리해 Cargo의 빌드 지문이 가리키는 실행 파일을 덮어쓰지 않는다.

## 자동 시험

E2E에 필요한 앱 서버와 가짜 키움을 함께 준비한다.

```sh
python3 scripts/dev.py build --with-fake
cd web
VALLY_E2E_BIN_DIR=../target/dev/bin ./node_modules/.bin/playwright test
```

가짜 키움의 JSON 시험 자료는 실행 파일에 포함한다. 빌드한 worktree를 제거해도 캐시에서 복원한 실행 파일이 그 경로를 읽지 않는다. SQLite·DuckDB 데이터 파일, 로그와 웹 빌드는 각 worktree에서 따로 준비한다.

Rust 검사는 같은 개발용 DuckDB를 사용한다.

```sh
python3 scripts/dev.py cargo clippy -p server --all-targets -- -D warnings
python3 scripts/dev.py cargo test -p server
python3 scripts/dev.py cargo test -p fake-kiwoom
python3 scripts/test-dev.py
```

도구는 `--locked`와 개발용 기능 선택을 붙인다. 컴파일만 저장소 공통 잠금 안에서 작업 수 4로 수행한다. `cargo test`는 `--no-run`으로 먼저 컴파일한 뒤 잠금 밖에서 실행한다. 이 명령에 외부 `flock`을 추가하면 같은 잠금을 이중으로 기다리므로 도구가 잠금을 관리하게 한다.

일반 Cargo와 CI·배포 명령은 기존 bundled DuckDB가 기본이다. 사전 빌드를 사용하지 않는 개발 검사는 다음처럼 실행한다. `ccache`가 설치돼 있으면 C/C++ 컴파일에 자동으로 연결한다.

```sh
python3 scripts/dev.py --bundled cargo check -p server
```

## 공유 범위와 무효화

캐시는 `git worktree list`의 첫 번째 주 worktree 안에 있는 `target/dev-cache`를 사용한다. 같은 Git 저장소의 worktree들은 이 위치를 찾는다. 주 worktree를 지울 때 캐시도 지워질 수 있으므로 독립된 작업 폴더의 절대 경로를 `VALLY_DEV_CACHE_DIR`로 지정할 수 있다. worktree별 Cargo `target`은 계속 분리한다.

```sh
python3 scripts/dev.py status
python3 scripts/dev.py status --with-fake
```

실행 파일 캐시 키는 workspace의 `crates/` 소스·시험 자료, `Cargo.toml`, `Cargo.lock`, `.cargo/` 및 상위·사용자 Cargo 설정, 개발 도구·DuckDB 고정값, Rust·Cargo·C/C++ 도구 체인과 빌드 환경을 포함한다. 각 크레이트의 `target` 안에 생긴 SQLx 시험 DB 등 빌드 출력, UI 파일과 Git 커밋 ID는 포함하지 않는다. 같은 소스가 다른 커밋·worktree에 있어도 재사용한다. 앱 서버 단독 준비와 가짜 키움을 포함한 준비는 별도 키다. 테스트 실행 파일은 worktree 사이에서 공유하지 않는다.

각 캐시 항목은 잠금 아래에서 임시 디렉터리에 준비한 뒤 완성된 상태로 게시한다. 내려받기·컴파일·복사 실패나 빌드 도중 입력 변경은 새 실행 파일 캐시를 게시하지 않는다. 기존 항목이 손상되면 체크섬을 확인해 다시 준비한다. 빌드가 실패하면 명령은 실패로 끝나며 다른 버전의 서버를 대신 실행하지 않는다.

## DuckDB 버전 갱신

현재 사전 빌드는 Linux x86_64 호스트를 지원한다. 공식 아카이브와 라이브러리의 SHA-256, 엔진 버전과 원본 커밋은 `scripts/duckdb-prebuilt.json`에 고정한다. 실행 전에 체크섬과 라이브러리의 엔진 버전을 확인한다. 한 번 받은 뒤에는 네트워크 연결 없이 재사용할 수 있다.

DuckDB를 올릴 때는 `Cargo.lock`의 `duckdb`·`libduckdb-sys` 버전과 고정 파일을 함께 갱신한다. 해당 버전의 `libduckdb-sys/.duckdb-release`가 가리키는 공식 라이브러리를 받아 원본 커밋·엔진 버전을 맞추고 체크섬을 기록한다. 다른 호스트 지원도 확인한 공식 아카이브를 고정 파일에 추가한 뒤 시험한다. 등록되지 않은 호스트는 `--bundled`로 소스 빌드를 사용한다.

공식 동작: [duckdb-rs 빌드 방식](https://github.com/duckdb/duckdb-rs#notes-on-building-duckdb-and-libduckdb-sys), [ccache의 디렉터리 간 재사용](https://ccache.dev/manual/latest.html#_compiling_in_different_directories).
