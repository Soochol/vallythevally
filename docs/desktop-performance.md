# 데스크톱 앱 성능 측정

[데스크톱 앱 플랜](plans/desktop-app.md)의 성능 절(S4, 결정 D1·D5)이 묻는 두 가지를 같은 부하로 다시 잴 수 있게 만든 명령과, 개발 PC에서 잰 값이다. 하나는 개인 엔진과 화면 사이 통신 비용(앱 프로세스 안 루프백 WebSocket과 Tauri 2 IPC 채널), 다른 하나는 앱 창(WebView)의 차트 그리기 성능이다. 결과는 `engine-split-design`이 IPC 방식과 껍데기를 확정하는 근거다.

## 한 줄 결론

- 통신은 두 길 모두 초당 3,000건에서 받은 수가 보낸 수와 같고, 지연 p99가 1ms 아래다(WebSocket 0.63ms, IPC 0.36ms). 시계 해상도가 1ms라 그 아래는 구별되지 않는다. 길을 가르는 차이는 화면 CPU다. IPC 채널이 WebSocket의 2.5~2.7배다(1,000건 8.1% 대 3.2%, 3,000건 16.7% 대 6.2%).
- 차트는 두 브라우저 모두 60fps를 놓치지 않았다. 그러나 이 값은 **GPU 없는 소프트웨어 그리기**에서 나왔고, WebKitGTK의 화면 CPU가 Chromium의 약 9~10배다. 이 PC의 WebKitGTK 값은 Windows WebView2 값을 말해 주지 않는다.

## 측정 환경

| 항목 | 값 |
|---|---|
| OS | Linux 7.0.0-43-generic x86_64 (glibc 2.43), 논리 코어 32 |
| 앱 창의 화면 엔진 | WebKitGTK 2.52.6 (Tauri 2.12.7) |
| 견주는 브라우저 | Playwright Chromium 158 (`chromium-1254`) |
| 화면 | `xvfb-run -a`의 가상 화면. 앱과 Chromium은 X11로만 띄운다(`GDK_BACKEND=x11`, `--ozone-platform=x11`) |
| GPU | **없음으로 고정했다.** `LIBGL_ALWAYS_SOFTWARE=1`과 `LP_NUM_THREADS=4`(소프트웨어 GL 스레드를 4개로 제한), Chromium은 `--disable-gpu`. 이것이 없으면 Chromium은 이 PC의 GPU를 쓴다 |
| 빌드 | 앱은 `cargo build --release --features bench`. 측정 서버와 송신은 release다 |
| 부하 | 합성 체결을 정한 속도로 30초씩 보낸다. 길과 브라우저는 하나씩 차례로 돈다 |
| 원본 | `desktop/bench/results/linux-dev-pc.json`. 아래 표는 이 파일에서 `desktop/bench/table.py`로 만든 것이다 |

## 무엇을 재는가

- **메시지.** `/api/ws`의 `feedTrades`와 같은 모양의 JSON 한 건(`type`, `sub`, `seq`, `trades[{t, price, qty, venue, strength}]`)에 보낸 시각 `sentAt`(epoch ms)을 더했다. 메시지 한 건에 체결 한 건이다.
- **길 (가).** 앱 프로세스 안 루프백 WebSocket 서버(`tungstenite`) → 화면의 `WebSocket`. 화면이 `{perSecond, seconds}`를 보내면 서버가 정한 속도로 보낸다.
- **길 (나).** `tauri::ipc::Channel`. 화면이 `bench_stream` 명령을 부르면 앱이 채널로 보낸다. 화면은 루프백 HTTP로 서빙한 원격 출처 페이지이므로 실제 앱처럼 원격 URL에 대한 권한이 있어야 한다. 그 권한은 `desktop/bench/capability.json`이고 측정 빌드가 실행 중에만 더한다.
- **지연.** 화면이 받은 시각에서 `sentAt`을 뺀다. 두 시계는 같은 PC의 같은 벽시계지만 WebKit은 `performance.now()`를 1ms로 깎는다. 그래서 시작 전에 `/now`를 100번 불러 가장 빠른 20번의 중앙값으로 두 시계의 차이를 구해 더한다. **표의 지연은 ±1ms 안에서만 믿는다.** p50이 음수이거나 p50과 p99가 같게 나오는 것은 이 해상도 때문이다. 길 사이 지연 차이를 말할 수 있는 값이 아니다.
- **송신.** 정한 일정(`i / 초당 건수`)에 맞춰 잠들었다 깨어 보낸다. 바쁜 대기는 쓰지 않는다. 늦으면 따라잡으며 보낸다. 시각은 실제로 보낼 때 찍는다.
- **정합.** 화면이 받은 수, 앱이 보낸 수(마지막 `end` 메시지), 기대 수(`초당 건수 × 30`)가 모두 같아야 한다. 다르면 명령이 실패로 끝난다.
- **CPU.** 측정 구간 동안 화면 프로세스(WebKitGTK는 `WebKitWebProcess`와 `WebKitGPUProcess`, Chromium은 renderer와 gpu-process)의 CPU 시간 증가를 구간 길이로 나눈 값이다. 한 코어가 100%다. 앱 프로세스(서버와 송신)의 값은 JSON의 `host`에 있다. Linux의 `/proc`으로만 잰다. 다른 OS에서는 `-`다.
- **차트.** `lightweight-charts` 5.2.1(`web/package.json`과 같은 판)로 1분봉 캔들 차트 하나를 그린다. 과거 봉 300개를 깔고, 체결 한 건마다 마지막 봉을 `series.update`로 갱신한다. 체결을 묶어 프레임당 한 번 그리지 않는 가장 거친 경우다. `requestAnimationFrame` 간격이 프레임 시간이다. **놓친 비율**은 간격이 25ms(60fps 한 프레임 16.7ms의 1.5배)를 넘은 프레임의 비율이다. 같은 측정 화면과 같은 WebSocket 체결 흐름을 Tauri 창과 Chromium에서 돈다.

## 결과

개발 PC(위 환경), 각 30초.

### 통신

| 길 | 초당 건수 | 보낸 | 받은 | 지연 p50 (ms) | 지연 p99 (ms) | 화면 CPU (%) |
|---|---:|---:|---:|---:|---:|---:|
| 루프백 WebSocket | 1000 | 30000 | 30000 | -0.28 | -0.28 | 3.2 |
| 루프백 WebSocket | 3000 | 90000 | 90000 | 0.28 | 0.63 | 6.2 |
| Tauri IPC 채널 | 1000 | 30000 | 30000 | 0.47 | 0.47 | 8.1 |
| Tauri IPC 채널 | 3000 | 90000 | 90000 | 0.02 | 0.36 | 16.7 |

### 차트 그리기

| 브라우저 | 초당 건수 | 프레임 p50 (ms) | 프레임 p99 (ms) | 놓친 비율 | fps | 갱신 지연 p99 (ms) | 화면 CPU (%) |
|---|---:|---:|---:|---:|---:|---:|---:|
| Tauri 창(WebView) | 1000 | 17.0 | 19.0 | 0.0% | 60.0 | 7.17 | 251.6 |
| Tauri 창(WebView) | 3000 | 17.0 | 20.0 | 0.0% | 59.9 | 9.04 | 266.9 |
| Playwright Chromium | 1000 | 16.7 | 16.8 | 0.0% | 60.0 | 1.58 | 24.8 |
| Playwright Chromium | 3000 | 16.7 | 16.8 | 0.0% | 60.0 | 1.56 | 29.0 |

## 해석

- **통신.** 두 길 모두 초당 3,000건을 한 건도 잃지 않고 같은 순서로 전달했다. 지연은 시계 해상도(1ms) 아래라 길 사이를 가르지 못한다. 가를 수 있는 것은 화면 프로세스 CPU다. IPC 채널의 CPU가 더 큰 이유는 확인하지 않았다(추정: 채널 메시지마다 앱이 JSON으로 직렬화해 WebView로 넘기는 경로가 WebSocket 프레임보다 무겁다). 판단에 쓸 기준은 "지연이 아니라 CPU와 코드 복잡도"다.
- **차트.** 두 브라우저 모두 60fps를 놓치지 않았다. Tauri 창은 프레임 p99가 19~20ms로 Chromium(16.8ms)보다 길고, 갱신 지연 p99도 7~9ms로 Chromium(1.6ms)보다 길다. 화면 CPU 차이(약 250% 대 약 25%)는 소프트웨어 그리기 경로의 차이다. WebKitGTK의 소프트웨어 GL이 Chromium의 `--disable-gpu` 소프트웨어 합성보다 훨씬 무겁다. 이 차이를 WebView 자체의 성능으로 읽으면 안 된다.
- **WebKitGTK 값은 Windows WebView2 값이 아니다.** WebView2는 Chromium이라 Windows의 차트 그리기는 오른쪽 Chromium 줄에 가까울 것으로 추정한다(추정이다). 확인은 결정 D5의 Windows PC에서 같은 명령으로 한다. macOS의 WKWebView도 WebKitGTK와 다른 엔진 빌드다.
- **한계.** GPU가 없는 환경의 값이다. 실제 GPU가 있는 PC에서는 프레임 시간과 CPU가 모두 다르다. 한 번 잰 값이고 반복 분산을 보지 않았다. 지연은 위 ±1ms 한계가 있다.

## 다시 재는 방법

준비는 Rust, Node와 pnpm, Playwright Chromium(`cd web && pnpm install --frozen-lockfile && pnpm exec playwright install chromium`)이다. Linux는 [데스크톱 앱 빌드](desktop-builds.md)의 준비 패키지와 `xvfb-run`도 필요하다. 저장소 루트에서 실행한다.

```sh
xvfb-run -a desktop/bench/run.sh --out desktop/bench/results/linux-dev-pc.json
```

Windows와 macOS는 실제 화면에서 같은 명령(`python desktop/bench/run.py --out desktop/bench/results/<이름>.json`)을 돈다. GPU를 쓰는 값을 재려면 `VALLY_BENCH_HARDWARE_GL=1`을 준다(Linux의 소프트웨어 고정은 끄는 것이고, 다른 OS에는 원래 고정이 없다). Windows·macOS 실행은 이 PC에서 시험하지 못했다. CPU 열은 Linux에서만 채워지고 나머지는 `-`다. 옵션은 `--seconds`(기본 30), `--rates`(기본 `1000,3000`), `--out`이다. 한 번에 약 5분 걸린다. Chromium 위치는 Playwright 캐시에서 찾고, 다르면 `VALLY_BENCH_CHROMIUM`으로 준다. 샌드박스가 막으면 `VALLY_BENCH_CHROMIUM_NO_SANDBOX=1`을 준다.

명령은 앱 빌드(`desktop/scripts/cargo.py bench-build`), 측정 화면 준비, 길 × 건수 4번, 차트 브라우저 × 건수 4번을 차례로 돌고 JSON 하나를 쓴다. 받은 수와 보낸 수가 다르거나 화면이 오류를 알리면 실패로 끝난다. 문서의 표를 새 JSON에서 다시 만들려면 `python3 desktop/bench/table.py <JSON>`을 쓴다.

## 측정 명령이 기본 빌드에 들지 않는 방법

- 측정 서버, `bench_stream` 명령, 추가 의존성(`tungstenite`, `serde_json`)은 cargo 기능 `bench` 안에만 있다. 기본 빌드에는 컴파일되지 않는다.
- 명령의 권한 파일은 `bench` 빌드의 `build.rs`만 만들고, 기본 빌드는 그 폴더(`src-tauri/permissions/autogenerated`)를 지운다.
- 원격 출처에 권한을 주는 capability는 `src-tauri/capabilities/`가 아니라 `desktop/bench/capability.json`에 있고, `bench` 빌드가 실행 중에 더한다. 기본 빌드의 capabilities와 `tauri.conf.json`에 측정 명령이 없다는 것은 `src/capabilities.rs`의 시험이 확인한다.
- 측정 빌드는 환경변수 `VALLY_BENCH_STATIC_DIR`가 있을 때만 측정 모드로 돈다. 없으면 보통 앱이다.
