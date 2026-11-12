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
| `tmp/` | 실행별 준비 경로 (브라우저 임시는 짧은 `target/t` 아래 고유 경로) |
| `results/` | Playwright 결과·실패 추적 |
| `report/` | HTML 보고서 |

도구가 출력한 경로에서 결과를 확인한다. 기본 worker는 2이며 Playwright 인수로 바꿀 수 있다. `--output`을 직접 지정하면 해당 경로를 사용하므로 동시 실행마다 다른 경로를 선택한다. 브라우저 임시 경로는 절대 경로로 정규화해 `TMPDIR`로 전달한다.

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

## 설치 전에 Chromium 진단

```sh
python3 scripts/web.py doctor
python3 scripts/web.py doctor --headed --json
```

빌드·설치·인증 요청 없이 Python·Node·pnpm·Playwright·브라우저 파일과 실제 Chromium 페이지 실행을 확인한다. 기본은 headless이며 `--headed`는 headless와 headed를 각각 실행한다. DISPLAY 부재, 의존성 부재, 실행 실패와 TMPDIR의 Unix socket 길이 문제는 별도 상태다. CUA 연결은 검사하지 않으므로 CUA 실패를 로컬 Chromium 실패로 해석하지 않는다. `--json`은 JSON Lines로 진단과 manifest 경로를 출력한다. 실패는 종료 코드 1이다.

기본 브라우저 `TMPDIR`는 worktree 안의 짧은 `target/t`다. Chromium과 E2E는 그 아래에 고유한 임시 디렉터리를 만든다. doctor는 사용자가 지정한 `TMPDIR`도 검사한다. 긴 경로로 실패하면 `TMPDIR`를 해제하거나 worktree 안의 짧은 경로를 지정해 다시 진단한다. doctor가 설치를 대신 실행하지 않는다.

## 명시적으로 실제 DART 확인

```sh
python3 scripts/web.py live --mode connect
python3 scripts/web.py live --mode full --headed --timeout 600
python3 scripts/web.py live --mode full --headed --key-file /absolute/path/to/.env
```

`OPENDART_API_KEY` 환경변수 또는 명시한 `--key-file`에서 키 하나만 읽는다. 키가 없으면 준비·접속 없이 `not_configured`와 종료 코드 1을 기록한다. 파일을 복사하지 않고 서버 자식의 환경에만 키를 전달한다. 기존 `VALLY_ENV_FILE`·키움 설정·proxy 환경은 자식에 넘기지 않는다. 명령을 명시 실행하면 실제 DART를 호출하므로 자동 시험에서 사용하지 않는다.

각 실행은 독립 fake-kiwoom과 앱 서버를 동적 loopback 포트로 시작한다. DB·가짜 토큰·잠금·로그는 `target/web-runs/live-<고유값>/`에 둔다. 사용자 서버와 실제 키움은 사용하지 않는다. 종료 시 자신이 시작한 프로세스만 중지한다. 제품의 DART client·TLS·인증서 검증을 그대로 사용하며 별도 Python DART 호출은 하지 않는다.

- `connect`는 새 DB에서 `corpCode.xml`·`company.json`을 통한 `005930`의 회사 식별을 확인한다. `connected`는 전체 수집과 UI를 검증했다는 뜻이 아니다.
- `full`은 기존 서버·WASM 준비와 현재 UI 빌드 후 전체 수집이 `ready`로 끝나고 available 매출액이 존재해야 한다. 이어 Chromium에서 같은 보고연도의 표시값을 API 숫자와 비교하고 스크린샷을 남긴다. 수집 중의 available 값, `partial_failure`, 미확인·미공시·산출 불가만 있는 결과는 성공으로 세지 않는다. 각 지표의 available 개수와 상태·사유를 `result.json`에 남긴다.

종목은 `005930` 하나로 고정한다. 준비 이후 원천 단계는 `--timeout` 10~600초(기본 300초), 앱 조회는 최대 300회이며 UI는 별도 최대 120초다. refresh POST와 자동 재실행은 없다. 제품 DART client의 요청 간격 250ms와 단일 수집 작업에 따라 원천 단계의 요청 상한은 `4 × timeout + 2`다. 요청수를 프록시로 측정한 값은 아니며, 실제 호출은 준비와 응답 시간에 따라 더 적다. 빠른 mode도 제품 API가 시작한 수집은 종료 직전까지 진행될 수 있다. 네트워크 실패나 시간 초과는 실패 결과를 남긴다.

`result.json`, `api.json`, `browser.json`, `financials.png`, 정제된 서버 로그와 `manifest.json`을 함께 확인한다. 이전 DB·과거 실원천 로그는 재사용하지 않는다. trace·인증 헤더·인증 URL은 수집하지 않는다. 자동 행동 시험은 loopback 또는 가짜 모듈만 사용한다.

```sh
python3 scripts/test-live.py
```

## 실행 근거 확인

`web.py wasm/check/e2e/doctor/live`는 실행별 `target/web-runs/<종류>-<고유값>/manifest.json`을 남긴다. `e2e`와 `live --mode full`은 현재 실행의 `dist`를 다시 빌드하고, 브라우저 전후 source·UI 해시를 확인한다. 이전 `web/dist`로 대체하지 않는다. 준비 실패 시 이후 단계는 `not_run`이며 Playwright를 실행하지 않는다.

manifest는 HEAD, dirty 여부, 비밀 파일을 제외한 source 지문, 서버·DuckDB·WASM·UI의 SHA-256과 기존 빌드 키, 명령·종료 코드·시간·로그 경로를 기록한다. `execution`의 `direct`와 `reused`는 이번 빌드와 기존 지문 검증 후 재사용을 구분한다. 전체 종료 상태와 각 명령의 종료 코드는 별개다. 환경 전체와 diff 원문은 저장하지 않는다. 마지막 JSON 한 줄의 `manifest` 경로로 성공·실패 모두 확인한다. 로그는 키·토큰·인증 URL·헤더를 정제한다.
