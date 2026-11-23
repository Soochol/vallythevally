# 데스크톱 앱 빌드와 실행

`desktop/`은 Tauri 2 껍데기다. 창이 `vally-server`(지금의 개인 엔진 전체)를 자식 프로세스로 띄우고, 엔진이 응답하면 `http://127.0.0.1:<포트>/`를 연다. 화면(`web/`)과 서버 코드는 고치지 않는다. 창은 엔진의 루프백 HTTP·WebSocket만 부르고 Tauri IPC는 시작 화면 하나만 쓴다. 계획과 결정은 [데스크톱 앱 플랜](plans/desktop-app.md)에 있다. 이 뼈대는 배포하지 않는다. 루프백 API 보호가 아직 없다.

## 준비 패키지

Linux 빌드에는 WebKitGTK 개발 패키지가 필요하다. 사람이 `sudo`로 설치한다. 작업자는 설치하지 않는다.

```sh
sudo apt install libwebkit2gtk-4.1-dev libsoup-3.0-dev libjavascriptcoregtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev libxdo-dev libssl-dev build-essential file
pkg-config --exists webkit2gtk-4.1 libsoup-3.0 javascriptcoregtk-4.1 && echo ok
```

연기 시험은 `xvfb-run`, `strace`, `xwininfo`, `dbus-daemon`, `unshare`(사용자·네트워크 이름공간)도 쓴다. Node와 pnpm은 `@tauri-apps/cli`로 번들을 만들 때만 필요하다. `cargo`만으로 빌드·시험·실행이 된다.

## 구성

| 자리 | 내용 |
|---|---|
| `desktop/src-tauri/` | 앱 크레이트. 자기 `[workspace]`와 `Cargo.lock`이 있어 루트 워크스페이스에 들지 않는다. `tauri`, `tauri-build`, `tauri-plugin-single-instance`는 정확한 판을 고정했다 |
| `desktop/ui/` | 창이 처음 여는 시작 화면("엔진을 시작하는 중"과 실패 문구). `frontendDist`가 `web/dist`에 기대지 않는다 |
| `desktop/package.json`, `pnpm-lock.yaml` | `@tauri-apps/cli` 2.12.6 고정 |
| `desktop/src-tauri/tauri.bundle.conf.json` | 번들 때만 덧붙이는 설정(엔진 sidecar, `web/dist` 자원). 기본 설정에 넣지 않은 것은 파일이 없을 때 `cargo`가 실패하지 않게 하려는 것이다 |
| `desktop/scripts/cargo.py` | 공통 컴파일 잠금과 작업 수 4 아래에서 `build`·`clippy`·`test`·`check`를 돈다 |
| `desktop/scripts/smoke.sh`, `smoke.py` | 연기 시험 |

## 빌드와 실행

저장소 루트에서 실행한다. 엔진과 화면 파일은 개발 실행 때 아래 위치를 쓴다.

```sh
python3 scripts/dev.py build
python3 .claude/skills/verify-vally/scripts/build_ui.py web/dist
python3 desktop/scripts/cargo.py build
desktop/src-tauri/target/debug/vally-desktop
```

앱이 엔진 실행 파일을 찾는 순서는 `VALLY_DESKTOP_ENGINE_BIN`, 앱 실행 파일 옆의 `vally-server`, 디버그 빌드의 `target/dev/bin/vally-server`다. 화면 파일 폴더는 `VALLY_DESKTOP_WEB_DIR`, 번들 자원 `web-dist`, 디버그 빌드의 `web/dist` 순이다. 두 `VALLY_DESKTOP_*`는 앱만 읽고 엔진에 넘기지 않는다.

시험과 검사는 병합 검사 단계 `desktop`과 같은 명령이다.

```sh
python3 desktop/scripts/cargo.py check
```

`clippy --locked --all-targets -- -D warnings`와 `cargo test --locked`를 차례로 돈다. 컴파일은 저장소 공통 잠금과 작업 수 4를 따르고 `VALLY_COMPILE_LANE=gate`이면 `compile-gate.lock`을 잡는다. 시험 실행은 잠금 밖이다. 이 크레이트의 `target`은 `desktop/src-tauri/target`이다.

### 번들

번들에는 release 엔진이 sidecar로 들어간다. 개발용 `target/dev/bin/vally-server`는 `libduckdb.so`가 따로 필요해 번들에 쓰지 않는다. 대상 triple은 `rustc -vV`의 `host`다.

```sh
flock "$(git rev-parse --path-format=absolute --git-common-dir)/compile.lock" env CARGO_BUILD_JOBS=4 cargo build --locked --release -p server
mkdir -p desktop/src-tauri/binaries
cp target/release/vally-server "desktop/src-tauri/binaries/vally-server-$(rustc -vV | sed -n 's/^host: //p')"
python3 .claude/skills/verify-vally/scripts/build_ui.py web/dist
cd desktop && pnpm install --frozen-lockfile --ignore-workspace && pnpm tauri build --config src-tauri/tauri.bundle.conf.json
```

`desktop/src-tauri/binaries/`는 저장소에 넣지 않는다. Windows 설치본 빌드와 코드 서명은 이 작업의 범위 밖이다.

## 앱 자료 폴더

앱 자료 폴더는 Tauri의 `app_data_dir`이고 식별자는 `com.vallythevally.desktop`이다.

| OS | 위치 |
|---|---|
| Linux | `$XDG_DATA_HOME/com.vallythevally.desktop`(기본 `~/.local/share/com.vallythevally.desktop`) |
| Windows | `%APPDATA%\com.vallythevally.desktop` |
| macOS | `~/Library/Application Support/com.vallythevally.desktop` |

엔진의 파일은 모두 그 아래에 둔다. `data/`에는 사용자 DB(`vally.db`), 스크리너 저장소, 재무 DB, ETF·시장 표본·테마 폴더가 있다. `state/`(Unix 권한 0700)에는 잠금(`server.lock`), 키 목록(`kiwoom-key.json`), 토큰(`token.json`, `kis-token.json`), 계정 상태(`account.json`)가 있다. 화면의 WebKit 저장소도 같은 폴더에 생긴다.

## 엔진 환경 규칙

엔진은 `env_clear()`로 띄우고 환경을 새로 만든다. 부모의 `VALLY_*`·`KIWOOM_*`·`KIS_*`·`OPENDART_API_KEY`는 하나도 물려주지 않는다. 개발자의 `~/.config/vally`와 `$XDG_STATE_HOME/vallythevally`에 있는 키나 토큰을 읽지 않게 하려는 것이다.

- 운영체제 기본값만 통과한다: `PATH`, `LANG`, `LC_ALL`, `LC_CTYPE`, `TZ`, `TMPDIR`, `SystemRoot`, `SystemDrive`, `windir`, `TEMP`, `TMP`.
- 앱이 정하는 값: `HOME`(앱 자료 폴더), `XDG_STATE_HOME`(`state/`), `VALLY_BIND`(루프백 빈 포트, 띄울 때 고른다), `VALLY_STATIC_DIR`, 그리고 위 파일의 경로 11개(`VALLY_DB_PATH`, `VALLY_SCREENER_DB_PATH`, `VALLY_FINANCIAL_DB_PATH`, `VALLY_ETF_PDF_DIR`, `VALLY_MARKET_SAMPLES_DIR`, `VALLY_KIWOOM_THEMES_DIR`, `VALLY_LOCK_PATH`, `VALLY_TOKEN_PATH`, `VALLY_KIWOOM_KEY_PATH`, `VALLY_KIS_TOKEN_PATH`, `VALLY_ACCOUNT_STATE_PATH`).
- 엔진이 응답하는 것(`GET /api/server-mode`이 200)을 60초까지 기다린다. 응답하지 않거나 자식이 끝나면 시작 화면이 실패 문구와 엔진 로그 마지막 12줄을 보인다. 엔진 로그는 앱의 표준 오류에도 `[engine]` 접두어로 흐른다.

## 수명

- 앱을 닫으면 엔진에 종료 신호(Unix는 SIGTERM)를 보내 10초까지 기다린 뒤 끝나지 않으면 강제로 끝낸다.
- 앱이 강제로 죽어도 엔진이 남지 않는다. Linux는 부모 죽음 신호(`PR_SET_PDEATHSIG`, SIGKILL)를 쓴다. 이 신호는 엔진을 띄운 스레드가 끝날 때 오므로 앱의 `setup`(주 스레드)에서 띄운다. Windows는 Job Object(`KILL_ON_JOB_CLOSE`)를 쓴다. Windows 쪽은 이 PC에서 시험할 수 없어 `lifetime.rs`와 엔진·환경 모듈이 `x86_64-pc-windows-msvc`로 컴파일되는 것만 확인했다. 실제 동작은 미검증이다.
- 두 번째 실행은 새 엔진을 띄우지 않고 기존 창을 앞으로 가져온다(`tauri-plugin-single-instance`). Linux는 D-Bus 세션 버스로 첫 실행을 찾는다. 세션 버스가 없으면 플러그인이 그대로 띄우지만, 같은 잠금 파일을 쓰는 두 번째 엔진은 시작하지 못한다(ADR 0004).

## 연기 시험

```sh
python3 scripts/dev.py build
python3 .claude/skills/verify-vally/scripts/build_ui.py web/dist
xvfb-run -a desktop/scripts/smoke.sh
```

`smoke.sh`가 앱을 빌드한 뒤 사용자·네트워크 이름공간(루프백만 있다) 안에서 `smoke.py`를 돈다. 빈 임시 앱 자료 폴더(`target/desktop-smoke/<실행>/xdg-data`)와 전용 D-Bus 세션 버스를 쓰고, 부모 환경에는 일부러 가짜 키 변수를 심어 엔진에 새는지 본다. 키가 없으므로 엔진은 키움을 부르지 않는다. Wayland 세션에서도 창이 가상 화면에만 뜨도록 `GDK_BACKEND=x11`을 준다. 단정하는 것은 다음이다.

- 엔진 환경에 부모의 키 변수가 없고, 모든 자료 경로가 앱 자료 폴더 아래이며, 부모가 준 DB 경로는 만들어지지 않았다.
- (가) 엔진에 붙인 `strace`가 창의 `GET /`와 `GET /api/*`를 읽었다.
- (나) 창에 `WM_DELETE_WINDOW`를 보내 닫으면 앱과 엔진이 모두 끝난다.
- (다) 앱을 `SIGKILL`하면 5초 안에 엔진도 없다. 엔진 pid는 앱의 자식으로 찾고 `pgrep -f`는 쓰지 않는다.
- (라) 두 번째 실행은 곧바로 정상 종료하고 엔진은 하나뿐이다.
- 엔진의 `connect`가 루프백 밖으로 나가지 않았고 엔진 로그에 증권사 연결 시도가 없다.

연기 시험은 병합 검사에 넣지 않는다.
