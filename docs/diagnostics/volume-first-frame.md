# 첫 화면의 기본 거래량 지연

첫 화면에서 봉과 거래량이 따로 나타나는 원인을 확인하고 기본 거래량의 대기를 줄인다. [이슈 #302](https://github.com/Soochol/vallythevally/issues/302)의 변경은 `volume, maPeriod:null`의 전체 수명주기에서 계산 상태를 봉 입력과 같은 동기 처리로 갱신한다. 초기 시리즈 데이터는 즉시 채우고 정상 실시간 갱신은 기존 프레임 큐에서 봉과 함께 반영한다. 거래량 이동평균과 다른 기술지표는 기존 WASM worker를 사용한다. 첫 화면 시험의 허용값 `<=1`은 유지한다.

## 시험의 세대 혼합과 제품 지연

기존 시험은 저장된 `IDX:001`을 먼저 열고 URL의 `005930`으로 전환할 수 있었다. 첫 IDX:001 봉과 뒤 005930 거래량의 표본을 빼면 서로 다른 세대를 비교한다. 조사 원자료의 혼합 사례는 `main500/volume0`, `main0/volume0`, `main0/volume0`, `main500/volume500` 순서였다. 계산한 gap은 3이지만 뒤 세대의 봉과 거래량은 같은 표본에 있다. 별도 계측에서는 gen1 생성, clear, gen1 응답 폐기, gen2 생성과 반영을 확인했다. 혼합 gap3 파일은 수치 gen을 직접 기록하지 않았으므로 두 실행을 같은 관측으로 합치지 않는다.

종목을 005930 하나로 고정해도 제품 지연은 남았다. 봉은 `ChartController.onReset`의 `setBars`에서 동기로 채워진다. 기존 거래량은 같은 호출의 `IndicatorLayer.reset`에서 worker에 create를 보낸 뒤 WASM 준비와 요청·결과 메시지를 기다렸다. 최초 created 응답은 `accept`에서 바로 그린다. 최초 결과가 DrawQueue의 다음 프레임을 기다린다는 가설은 조사에서 반박됐다.

## 기존 조사 105회의 결과

다음 수치는 변경 전 HEAD `f36258c2948d16940a06f339e11ba484ee5daf53`의 조사다. gap은 rAF callback이 시리즈 `data()`의 양수 길이를 처음 읽은 인덱스 차이다. 구현 후 결과와 섞지 않는다.

| 조건 | 횟수 | gap 분포 | `<=1` 실패 |
|---|---:|---|---:|
| 원래 URL 시험 | 20 | 0×19, 3×1 | 1 |
| worker 계측 URL control | 5 | 0×4, 3×1 | 1 |
| worker 계측 URL control 재측정 | 10 | 0×10 | 0 |
| worker 계측, 저장된 005930 | 10 | 1×6, 2×4 | 4 |
| worker 계측, 저장된 IDX:001 | 10 | 1×8, 2×2 | 2 |
| plain URL | 10 | 0×10 | 0 |
| plain 저장된 005930 | 10 | 1×5, 2×5 | 5 |
| plain 저장된 IDX:001 | 10 | 1×4, 2×6 | 6 |
| plain 단일 005930, WASM HTTP 80ms 지연 | 5 | 4×1, 5×4 | 5 |
| 계측 URL, worker script 수신 80ms 지연 | 5 | 2×3, 3×2 | 5 |
| 계측 URL, create 전송 80ms 지연 | 5 | 4×3, 5×2 | 5 |
| 계측 URL, created dispatch 80ms 지연 | 5 | 4×1, 5×4 | 5 |

500봉의 worker `Engines.handle(create)`는 계측 10회에서 2.3~4.4ms였다. 같은 계측의 봉 setData 완료부터 거래량 setData 완료까지는 26.4~63.7ms였다. Worker 준비와 메시지 전달·처리 기회가 계산보다 큰 구간이었다. WASM이 이미 준비된 뒤에도 요청 수신까지 긴 공백이 남는 사례가 있었다. 계산 시간만 줄이면 해결된다는 설명은 이 입력에서 지지되지 않는다.

모든 측정은 worker 1과 합성 Scenario를 썼고 추가 CPU 부하는 만들지 않았다. 기존 다른 프로세스가 있었으므로 유휴 기계 측정으로 부르지 않는다. 초기 준비 실패 한 건은 브라우저를 실행하지 않아 105회에서 제외했다. 원자료는 조사 worktree의 `target/logs/volume-investigation/report.md`, `distributions.json`, `plain-raw-10-plain-target.json`, `wasm-raw-00.json`, `generation-evidence.json`에 보관했다. 대형 trace와 로그는 소스에 넣지 않는다.

## 기본 거래량의 단일 소유자

[IndicatorLayer](../../web/src/chart/indicators/layer.ts)는 기존 shown, gen, 상태와 선을 유지한다. 기본 거래량만 worker create에서 제외한다. 초기 이력과 과거 prepend, 숨김 해제와 MA 해제는 `displayBars`가 중복을 제거한 봉을 `{t, v, up: c >= o}`로 매핑하고 시리즈를 즉시 채운다. 정상 실시간 tail은 기존 `syncOp` 판정 뒤 마지막 점을 동기로 갱신하고 `DrawQueue`에 넣는다. 같은 시각의 여러 체결은 마지막 값으로 합쳐진다. `ChartController.drawFrame`은 주 시리즈, 비교 종목, 지표의 순서로 큐를 비운다. 확정과 다음 봉이 한 프레임에 들어오면 각 시각의 마지막 값 두 개를 그린다. 과거 값 수정은 기존 reset 경로를 따르며 이전 큐를 버리고 즉시 다시 그린다. 거래량 처리의 초기 비용은 O(n), tail 추가 비용은 O(1)이다. 기존 feed와 displayBars의 배열 구성 비용까지 O(1)로 바꾼다는 뜻은 아니다.

동기 거래량은 기존 `toChartTime`, 상승·하락 거래량 색, 축과 패널 순서를 사용한다. 시리즈에 그리는 reset과 flush는 기존 `host.guard` 안에서 실행한다. 계산 상태와 큐만 바꾸는 정상 advance에는 guard가 필요하지 않다. 준비되면 같은 호출에서 ready가 되며 범례도 갱신된 점을 읽는다. 정상 실시간 시리즈 반영은 다음 flush에서 끝난다. MA를 끄면 이전 worker 엔진을 drop하고 새 gen을 부여한다. 늦은 이전 응답은 기존 gen 검사에서 버린다. 기본 거래량을 worker로 인계하는 단계는 없다. Worker가 고장 나도 기본 거래량은 남고 다른 기술지표의 계산 오류는 범례에 남는다.

## 대안과 관측의 한계

기본 거래량 전체를 동기로 소유하는 안을 선택했다. 봉의 거래량과 방향을 옮기므로 MA 수학을 JS로 복제하지 않는다. 거래량과 MA를 모두 동기로 옮기면 SMA의 초기화·현재 봉·확정 상태를 중복 구현해야 한다. 첫 raw만 동기로 그리고 worker에 인계하면 늦은 결과와 실시간 값의 소유권을 조정해야 한다. Worker 사전 준비는 메시지 왕복을 남긴다. 봉까지 지표 준비를 기다리게 하면 첫 봉의 대기가 늘어난다. 프레임 허용값만 늘리면 제품 지연과 세대 혼합을 가린다.

`frameProbe`는 시리즈 데이터 준비를 관측한다. 캔버스 픽셀, GPU compositor, 디스플레이 present 시각은 측정하지 않았다. 초기 시리즈를 같은 입력 처리에서 채우고 정상 실시간 시리즈를 같은 flush에서 갱신해도 실제 GPU 표시가 같은 프레임이라는 하드 보장은 하지 않는다. OS CPU scheduling의 인과와 각 IPC 구간의 개별 기여, 운영 발생률, 더 긴 이력의 비용도 미확인이다. 계측 route와 snapshot 비용, 실행 순서와 캐시 차이가 있으므로 기존 수치를 운영 성능이나 대안 간 속도 순위로 일반화하지 않는다.

## 회귀 검증

[첫 화면 시험](../../web/e2e/indicators.spec.ts)은 저장 종목을 005930으로 고정하고 `/`를 연다. 추가 회귀 한 개는 실제 WASM HTTP 요청만 80ms 지연한다. 봉 요청의 종목 집합과 양수 봉의 종가를 확인한 뒤 원래 `<=1`을 적용한다. 구현 전 root 직접 실행은 `main 7, volume 11, gap 4`, 종가 193500 하나에서 실패했다. 준비나 locator 실패가 아니다.

[Layer 행동시험](../../web/src/chart/indicators/layer.test.ts)은 초기·빈 이력, 중복 현재 봉, 과거 prepend, 현재 봉 거래량만 변경, 확정과 다음 봉, 과거 수정, 숨김과 표시, 테마와 패널 순서, MA 전환, 종목 변경과 이전 응답 폐기, worker 고장 격리를 확인한다. WASM 수신 실패 E2E도 봉과 기본 거래량의 표시와 다른 지표의 오류를 함께 확인한다. 전체 E2E는 PR 전에 root가 실행한다.

실시간 프레임 회귀는 [pending-frame-series.spec.ts](../../web/e2e/pending-frame-series.spec.ts)로 확인한다. 기본 거래량을 매 advance에서 즉시 그린 구현은 값과 예외 단언을 통과했지만, 대기 중 체결 네 번을 Histogram update 네 번으로 반영해 기존 두 번 묶음 단언에 실패했다. 수정은 정상 advance를 기존 큐에 넣어 같은 시각의 최종 값만 그린다. Layer 시험은 flush 전 범례의 최신 값과 이전 시리즈 데이터, flush 후 두 시각의 최종 값·색·시간을 따로 확인한다. E2E의 기대값과 timeout은 유지한다.
