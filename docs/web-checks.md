# 로컬 웹 검사와 E2E

저장소 루트에서 실행한다. Python 3.11 이상, Node·pnpm, Rust의 `wasm32-unknown-unknown` target, `wasm-pack`과 Playwright Chromium이 필요하다.

## 웹 검사

```sh
python3 scripts/web.py check
python3 scripts/web.py check src/chart/settings.test.ts
```

도구는 `pnpm install --frozen-lockfile`, WASM 준비, `tsc -b`, `vitest run`을 순서대로 실행한다. `check` 뒤의 인수는 Vitest로 전달한다. WASM은 입력과 산출물이 일치하면 재사용하고, 준비가 필요할 때 기존 공통 컴파일 잠금과 작업 수 4를 사용한다. 타입 검사와 단위 시험은 잠금 밖에서 실행한다.

## E2E

```sh
python3 scripts/web.py e2e e2e/search.spec.ts
python3 scripts/web.py e2e --grep '조건식' --workers=3
```

서버·가짜 키움 준비, frozen 의존성 설치, WASM 준비와 타입 검사, 현재 UI의 Vite 빌드가 성공한 뒤 Playwright를 실행한다. 준비 단계가 실패하면 시험을 실행하지 않는다. 실제 키움은 사용하지 않는다.

각 실행은 `target/web-runs/e2e-<고유값>/`에 다음 경로를 만든다.

| 경로 | 용도 |
|---|---|
| `dist/` | 이번 실행에서 빌드한 UI |
| `tmp/` | 시험 DB와 브라우저 임시 파일 |
| `results/` | Playwright 결과·실패 추적 |
| `report/` | HTML 보고서 |

도구가 출력한 경로에서 결과를 확인한다. 기본 worker는 2이며 Playwright 인수로 바꿀 수 있다. `--output`을 직접 지정하면 해당 경로를 사용하므로 동시 실행마다 다른 경로를 선택한다. 임시 경로는 절대 경로로 정규화해 `TMPDIR`로 전달한다.

도구는 `VALLY_E2E_BIN_DIR`로 준비한 서버 경로를, `VALLY_E2E_STATIC_DIR`로 이번 UI 빌드를 전달한다. 이전 `web/dist`는 이 실행의 웹 산출물로 사용하지 않는다. 직접 Playwright를 실행하는 CI는 기본 `target/debug`와 `web/dist` 경로를 계속 사용한다.

브라우저가 없는 환경에서는 웹 의존성 설치 후 Chromium을 준비한다. Linux 시스템 의존성과 sandbox 설정은 기존 프로젝트 절차를 따른다.

```sh
cd web
pnpm exec playwright install --only-shell chromium
```

## WASM 재사용과 직접 pnpm 명령

`pnpm wasm`, `pnpm typecheck`, `pnpm test`, `pnpm build`도 같은 WASM 준비 경로를 사용한다. 이 명령에 외부 `flock`을 추가하지 않는다. `build-wasm.sh` 자체가 준비 도구로 연결된다.

WASM의 입력은 해당 크레이트와 전이적인 로컬 의존성의 파일, workspace 매니페스트·lockfile, Cargo 설정, 빌드 도구·도구 체인과 빌드 환경이다. 산출물의 체크섬은 `target/web/wasm.json`에 저장한다. UI만 바뀌면 WASM을 재사용한다. 입력 변경·파일 누락·손상 시 다시 준비하며, 동시에 요청하면 잠금 획득 후 다른 요청이 준비했는지 재확인한다.

새 WASM은 임시 패키지에 빌드한 뒤 완성된 산출물로 교체한다. 빌드 실패나 빌드 도중 입력 변경은 이전 패키지를 새 입력의 결과로 기록하지 않는다. 이 WASM 재사용 기록은 worktree 안에서 관리한다. 서버 실행 파일의 worktree 간 공유는 [개발 서버 빌드 재사용](development-builds.md)을 따른다.
