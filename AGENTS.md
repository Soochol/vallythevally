# 작업 규칙

이 저장소에서 일하는 사람과 에이전트가 지킨다. 용어는 [`GLOSSARY.md`](GLOSSARY.md)를, 큰 결정은 [`docs/adr/`](docs/adr/)를 따른다.

## 코드

- Rust 코드는 rustfmt 형식이 아니다. 주변 코드 모양을 손으로 따르고, `cargo fmt`는 돌리지 않는다.
- 새 코드는 이름과 타입으로 뜻을 드러내고, 주석 줄은 쓰지 않는다.
- 비밀값(`.env`, 앱키, 토큰)은 커밋하지 않고, 이슈·PR·댓글에도 쓰지 않는다(ADR 0008).

## 시험

- 로컬 서버 준비: `python3 scripts/dev.py build`. 새 worktree·UI 전용 변경·Rust 변경에서의 재사용 조건과 캐시 복구는 [`docs/development-builds.md`](docs/development-builds.md)를 따른다.
- 서버: `python3 scripts/dev.py cargo clippy -p server --all-targets -- -D warnings`, `python3 scripts/dev.py cargo test -p server`(특정 파일만이면 `--test <이름>`)
- fake-kiwoom: `python3 scripts/dev.py cargo test -p fake-kiwoom`
- 개발 빌드 도구 변경 시: `python3 scripts/test-dev.py`.
- 웹: `cd web && pnpm install --frozen-lockfile && pnpm typecheck && pnpm test`
- e2e: `python3 scripts/dev.py build --with-fake`를 먼저 하고, `cd web && VALLY_E2E_BIN_DIR=../target/dev/bin ./node_modules/.bin/playwright test [e2e/<파일>]`. 가짜 키움은 자동 시험에서 사용한다.
- 키움은 fake-kiwoom으로만 시험한다. 시험에서 실제 키움을 부르지 않는다(ADR 0004).
- 로컬 시험은 unshare 없이 돌린다. `scripts/check.sh`는 지금 쓰지 않는다(나중에 CI로 옮긴다).
- 큰 빌드 출력과 임시 파일은 작업 폴더 안에 둔다.

## 병렬 검증

- 같은 저장소의 worktree들은 Rust·WASM 컴파일을 한 번에 하나씩 실행한다. 컴파일 작업 수는 `CARGO_BUILD_JOBS=4`로 제한한다.
- `scripts/dev.py`는 컴파일 명령마다 공통 잠금을 잡고 작업 수를 4로 제한한다. 이 명령 자체에는 바깥 `flock`을 덧씌우지 않는다. 일반 Cargo·CI·배포 빌드는 기본 bundled DuckDB를 유지한다.
- 공통 잠금은 `$(git rev-parse --path-format=absolute --git-common-dir)/compile.lock`이다. `flock "$(git rev-parse --path-format=absolute --git-common-dir)/compile.lock" env CARGO_BUILD_JOBS=4 cargo build -p server -p fake-kiwoom`처럼 컴파일 명령 하나에만 건다. `cargo check`, `cargo clippy`, `cargo test --no-run`, `pnpm wasm`도 같은 잠금을 쓴다.
- TypeScript 검사·Vite 빌드·Vitest·Playwright와 컴파일이 끝난 Rust 시험 실행은 잠금 밖에서 진행한다. Rust 시험은 필요한 대상을 `cargo test --no-run`으로 먼저 컴파일한 뒤 같은 옵션으로 실행한다.
- `pnpm typecheck`, `pnpm build`, `pnpm test`는 WASM 컴파일을 먼저 실행한다. 필요한 WASM을 잠금 안에서 한 번 준비한 뒤, 나머지는 web의 `./node_modules/.bin/tsc -b`, `./node_modules/.bin/vite build`, `./node_modules/.bin/vitest run`으로 나눠 실행할 수 있다. Rust·WASM 소스와 빌드 설정이 이전 검증 때와 같으면 기존 산출물을 재사용한다. 나눠 실행한 명령은 검증 보고에 적는다.
- worktree마다 `target`, 임시 DB, 로그, Playwright 결과 경로를 분리한다. 한 worktree에서 여러 Playwright를 실행하면 `--output`도 나눈다. 대기 중에는 잠금 소유자와 실행 단계를 확인하고, 다른 세션의 프로세스는 그대로 둔다.

## 배포

- 배포용 서버는 `cargo build --locked --release -p server`로 만든 `target/release/vally-server`를 사용한다. 기본 `bundled-duckdb` 기능을 유지한다.
- `target/dev/bin`, 공유 빌드 캐시와 가짜 키움은 개발·시험 전용이다. 개발용 동적 DuckDB 연결과 배포용 빌드를 구분한다.
- 실제 배포 직전에 release 빌드와 가짜 키움 환경의 기동·주요 동작을 검증한다. 개발 빌드 시험만으로 배포 검증을 갈음하지 않는다.

## 커밋과 PR

- 커밋 메시지는 영어, PR 본문은 한국어로 쓴다.
- PR 본문 첫 줄에 `Closes #<이슈>`를 단다. 병합은 merge commit(`gh pr merge --merge`)으로 한다.

## 이슈와 새 기능

새 기능은 **spec부터** 만든다. 기능 하나는 spec 이슈 하나가 대표하고, 실제 작업은 그 아래 작업 티켓으로 나눈다.

```
spec 이슈 (라벨 spec)              ← 기능의 원본: 문제, 해결, 규칙, 시험
 ├─ 작업 티켓 (ready-for-agent)    ← PR 하나 = 이슈 하나, 순서는 막힘 관계(blocked by)
 ├─ 작업 티켓
 └─ 나중에 생긴 개선·버그           ← 같은 spec 아래 sub-issue로 단다
```

- **정할 게 많고 흐릿하면:** 먼저 wayfinder 맵(라벨 `wayfinder:map`)으로 결정을 하나씩 닫은 뒤 spec을 쓴다.
- **방향이 분명하고 PR이 여러 개면:** 바로 spec 이슈를 쓰고 작업 티켓으로 나눈다.
- **PR 하나로 끝나는 작은 일이면:** spec 없이 이슈 하나에 범위와 완료 기준을 적는다.
- **구현 중에 규칙이 바뀌면:** spec 이슈 본문에 반영한다. spec이 닫혀 있어도 그 기능의 원본이다.
- **작업 티켓에 담을 것:** 범위, 확인할 수 있는 완료 기준(돌릴 시험), 담당(백엔드/프론트엔드)

## 알려진 함정

- 키움 종목 목록에 있어도 일봉을 주지 않는 종목이 있다(예: 002785 진흥기업우B). 종목 하나의 실패로 전체 작업을 멈추지 않고, 그 종목만 건너뛰고 기록한다(#116).
- 시험은 "처음부터 실패하는 경우"와 "도중에 실패하는 경우"를 둘 다 덮는다(#118).
- `VALLY_CLOCK_START`(가짜 시계)는 서버의 시간 판단만 바꾼다. HTTP `Date` 헤더는 실제 시각이다. 둘을 함께 쓰는 시계 시험은 `clockStart: null`로 돌린다(#117).
- Playwright `clock.setSystemTime`은 벽시계만 바꾸고 `performance.now`는 그대로다.
- 임시 시험 파일을 `web/` 밖에 두면 ESM 설정이 없어 `import.meta`가 실패한다.
- 웹 `tsconfig`의 lib에는 `Promise.withResolvers`와 `DOMHighResTimeStamp`가 없다.
