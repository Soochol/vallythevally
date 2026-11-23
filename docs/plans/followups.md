# 앞선 플랜의 남은 한계 처리

작성일 2026-11-23. 승인 시점의 기록이며 구현 중 바뀐 것은 반영하지 않는다.

기준: `origin/main` 7a80376e. 시세 공급원 고르기 코드(#24~#27)는 아직 병합되지 않은 PR #803(`orch/source-select-server/source-select-server`, cf921a3b)에서 읽었다.

## 사용자가 풀려는 문제

> 응 나중에 할일도 진행

앞선 플랜 ladder-order-ux와 multi-broker의 작업자들이 보고서 "미해결 사항"에 남긴 한계를 고친다. 오케스트레이터가 "나중에 할 일"로 모은 항목은 다음과 같다. 근거 보고서는 `~/.claude/orch/reports/<작업ID>/<작업ID>.md`다.

| 번호 | 근거 작업 | 한계 |
|---|---|---|
| #10 | order-same-price | ① 같은 신규 주문이 연달아 응답 없음이면 앞 재전송 id를 잃는다. ② 명령 장부가 창 공통이라 다른 창의 같은 주문이 응답 없던 id를 재시도로 이어받는다 |
| #11 | ladder-trade-gap | 체결 상자 오른쪽 6px 여백이 10호가 280px, 호가주문 421px 최소 폭에서는 0이다 |
| #13 | order-entry-keep | ① 닫은 창 id를 다시 받은 복제 창이 닫힌 창의 기억(수량·방식)으로 시작한다. ② 같은 가격 매도를 보내는 중에 미체결을 다시 읽으면 약 1초 동안 남은 수량이 실제보다 크게 채워진다 |
| #15 | kiwoom-keys | 키움 키 여러 개의 드문 순서 한계 4가지(보고서 미해결 1~4) |
| #19 | kis-market-rest | 한투 시세 조회 한계 가운데 코드로 고칠 수 있는 것 4가지 |
| #20 | kis-overview | 지수 일봉을 첫 쪽만 읽는다. 지수 종목 수 칸이 비면 0으로 보인다 |
| #24 | source-select-server | (미재현 의심) 키움 종목 목록 요청 중 한투로 바꿨다 되돌리면 늦게 온 목록이 버려지고 다시 요청하지 않을 수 있다 |
| #25 | source-select-server | (미재현 가설) KisStream이 activate와 재계획 사이에 구독 40자리 상한을 넘길 수 있다 |
| #26 | source-select-server | 공개 모드에서 한투 공급원이면 공개 사용량 TR 호출 수가 0으로 센다 |
| #27 | source-select-server | 키가 하나도 없을 때 스크리너 갱신을 거절하지 않는다. 파일에서 읽는 키 5개 제한이 증권사를 가리지 않는다는 보고가 있다 |

## 조사한 원인

- **#10 ①**: `web/src/features/order/commandLedger.ts`의 `resendIds`가 동작마다 id 하나만 둔다(`Map<string, string>`). 응답 없음이 두 번 나면 뒤 id가 앞 id를 덮는다.
- **#10 ②**: `useOrderWrites.ts`가 모듈 전역 `const ledger = createLedger(newIdFor)` 하나를 모든 호가주문창이 쓴다. 장부 키(`actionInAccount(placeAction(...), 계좌)`)에 창이 없다.
- **#11**: `web/src/styles/market-window.css`의 `@container (width < 68px) { .mw-tbox > * { --trade-gap:0px; } }`. 7자리 수량(약 62px)과 6px 여백, 5px 스크롤바가 상자(약 61.5px·64px)에 함께 들어가지 않아 여백을 0으로 줄였다.
- **#13 ①**: `web/src/stores/layout.ts`의 `freeWindowId`가 비어 있는 가장 작은 id(`order-2`)를 다시 준다. 기억 키는 `orderEntryKey(layoutId, windowId, code)`이고 창을 닫아도 지우지 않는다(order-entry-keep의 결정).
- **#13 ②**: 남은 수량 보정이 같은 가격 보내는 중 매도를 `write.since > listedAt`일 때만 더한다. 응답 전에 미체결을 다시 읽으면 `listedAt`이 쓰기 시작보다 늦어져 그 매도가 빠진다. 재현: `~/.claude/orch/reports/order-entry-keep/repro-same-price-reread.txt`(기대 `남은 40`, 실제 `남은 70`).
- **#15**: 키움 토큰 파일이 차단 기록(8050)과 발급 간격 기록을 파일 단위로 들고, 기본 파일(`token.json`)이 키 사이를 옮겨 다닌다(`kiwoom/key_file.rs`의 `paths_for_key`). 그래서 기록이 앱키를 따라가지 않는다.
- **#19**: `kis/market_rest.rs`
  - 일·주·월봉은 창이 `DAILY_PAGE_ROWS`(100)보다 적으면 끝으로 본다(`stock_chart_calendar`).
  - 당일 체결 연속조회 커서는 (초, 그 초에서 본 줄 수)다. 한 초에 한 쪽(30건)보다 많으면 진행하지 못해 멈춘다(`trades_page`).
  - 마스터 급감 검사는 코스피·코스닥 합계만 본다(`kis/master.rs`).
  - 지수 분봉은 빈 쪽에 more가 계속 오면 20쪽 뒤 오류로 끝난다(`index_chart_minutes`).
- **#20**: `kis/overview.rs`의 `trading_days`가 `IndexChart` 첫 쪽만 읽는다. `count()`가 빈 문자열을 0으로 읽고, 중립 타입 `market_source::overview::IndexBreadth`와 API `MarketOverviewBreadth`가 `u32`라 "없음"을 담지 못한다. 웹 `features/market-page/IndexCard.tsx`가 이 값을 그린다.
- **#24, #25**: 코드 읽기로 나온 의심이고 재현 시험이 없다. #24의 시험은 `crates/server/tests/source_switch.rs`에 쓰다 멈췄다.
- **#26**: `app.rs`가 공개 모드일 때 `crate::public::counted`를 키움 transport에만 씌운다. 한투 transport는 세지 않는다.
- **#27**: `screener/mod.rs`의 `refuse_without_kiwoom_key`가 `route.kis_listed_without_connected_kiwoom()`일 때만 거절한다. 한투 키도 키움 키도 없으면 지나간다. 넓은 규칙("키움이 연결되지 않으면 거절")은 기존 시험 52개를 깼다. 키 5개 제한은 PR #803의 `key_file.rs` `parse`가 이미 증권사별로 센다. 보고된 재현(키움 5개 + 한투 1개)이 남은 경로인지는 확인하지 못했다.

## 확정된 결정

1. 오케스트레이터가 모은 항목은 모두 고칠 대상이다. 비슷한 영역끼리 작업으로 묶는다.
2. #19 가운데 실제 응답으로만 확인할 수 있는 항목은 작업에 넣지 않는다. 아래 "실사용 확인 목록"에 남긴다.
3. #24·#25는 합성 transport 시험으로 먼저 재현하고, 재현되면 고친다. #27의 키 5개 제한도 같은 방식으로 한다.
4. 키움·한투 시험은 합성 transport만 쓴다. 성능을 가장 중요하게 본다. 고치면서 요청 수를 늘리면 늘어나는 요청 수의 상한을 성공 조건에 적는다.

## 스스로 정한 결정과 이유

- **#10 재전송 id는 동작마다 줄로 둔다.** 응답 없는 id를 모두 남기고, 같은 동작의 다음 신규가 가장 오래된 것부터 하나씩 꺼내 쓴다. id 하나를 덮어쓰지 않으니 서버 중복 방지가 두 건 모두에 걸린다.
- **#10 신규의 재전송 id만 창마다 나눈다.** 정정·취소·일괄 취소의 묶기(`issue`/`settle`)는 창 공통 그대로다. 두 창에서 같은 주문을 취소하면 한 번만 나가는 편이 맞다. 신규는 사용자 결정 D1("매번 보낸다")에 따라 창마다 새 주문이다.
- **#11은 좁은 상자에서 수량 글자를 줄인다.** 여백 6px를 지키고, 7자리 수량이 잘리지 않게 상자가 좁을 때만(지금 `width < 68px` 컨테이너 규칙 자리) 수량 글자 크기를 줄인다. 기본 폭의 글자 크기(11px)와 정렬은 그대로다. 421px 호가주문창 시험의 "글자 11px" 단언은 줄인 크기로 바뀐다. CSS 컨테이너 규칙만 쓰고 측정 스크립트는 쓰지 않는다(그리기 때 JS 비용 0).
- **#13 ①은 id를 새로 줄 때 그 id의 기억을 지운다.** `openWindow`·`duplicateWindow`가 id를 받는 순간, 그 레이아웃에서 그 창 id로 시작하는 기억을 지운다. 창을 닫는 것만으로는 지우지 않는다는 order-entry-keep 결정은 그대로다. id를 다시 쓰지 않는 방식(번호를 늘리기만 함)은 저장된 레이아웃과 시험의 창 id(`order-2`)를 바꾸므로 고르지 않았다.
- **#13 ②는 모르면 남은 수량을 작게 잡는다.** 크게 잡으면 사용자가 가진 것보다 많이 팔려다 거절당한다. 작게 잡으면 더 팔 수 있는 만큼을 사용자가 다시 넣으면 된다. 쓰기를 시작할 때 그 가격의 접수된 매도 수량을 기록해 두고, 목록에서 그만큼 늘어난 것을 보고 그 쓰기를 목록에 든 것으로 본다. 정확한 방법은 작업자가 정하되 성공 조건의 세 경우를 모두 맞춘다.
- **#15는 차단·발급 간격 기록이 앱키를 따라가게 한다.** 네 경우의 원인이 같다. 파일을 누가 갖느냐와 상관없이 앱키 식별(`credential_id`)로 기록을 찾게 하면 함께 풀린다.
- **#19 일·주·월봉은 빈 창이 올 때까지 이어 받는다.** 100건보다 적어도 그 창에 봉이 있으면 다음 창을 요청한다. 진짜 끝에서는 빈 창 한 번이 더 나간다. 긴 정지가 창 하나보다 길면 빈 창이 끝과 같아 보인다. 이를 줄이려 빈 창을 몇 번 더 받는 일은 하지 않는다. 늘 요청이 더 나가기 때문이다.
- **#19 당일 체결은 한 초를 다 못 받으면 그 초의 나머지를 건너뛰고 1초 이른 시각부터 이어 받는다.** 한투가 같은 초 안을 건너뛰는 입력을 주지 않는다. 건너뛴 사실은 그 쪽의 `skipped`나 같은 뜻의 칸으로 남긴다.
- **#19 마스터 급감 검사는 시장별로 한다.** 코스피 파일과 코스닥 파일을 각각 전 목록과 견준다. 합계 절반 규칙(ADR 0040)을 시장마다 적용한다.
- **#19 지수 분봉은 빈 쪽을 끝으로 본다.** 봉이 하나도 없는 쪽이 오면 more가 있어도 더 받지 않는다. 그때까지 받은 봉을 오류 없이 돌려주고 다음 커서를 두지 않는다.
- **#20 지수 일봉은 기간을 덮을 때까지만 연속조회한다.** 필요한 날 수를 채우면 멈춘다. 쪽이 100행이면 지금처럼 한 번이다.
- **#20 지수 종목 수는 "없음"을 담는다.** 중립 타입과 API의 다섯 칸을 `Option<u32>`(TS `number | null`)로 바꾼다. 키움 값은 지금처럼 숫자다. 웹은 없음을 "-"로 그리고 막대에서 뺀다.
- **#27 스크리너 갱신은 키움 키가 하나도 없을 때 거절한다.** 등록됐지만 아직 연결되지 않은 키는 지금처럼 기다린다. 넓은 규칙이 깬 것은 "연결 전" 경우이고, "키 없음"은 기존 시험의 전제와 겹치지 않는다.
- **#26은 한투 transport에도 같은 계수를 씌운다.** 키움과 한투 호출을 같은 `AtomicU64`에 더한다. 증권사별로 나눠 보이는 일은 하지 않는다(화면 변경 범위 밖).

## 작업

| 작업 ID | 항목 | 방식 | 순서 |
|---|---|---|---|
| `ladder-gap-narrow` | #11 | basic: CSS와 e2e만 바꾸는 화면 조정이다 | `kis-orders` 뒤. 421px 시험(`web/e2e/win-order-panels.spec.ts`)이 수량 글자 11px를 단언해 그 파일을 고쳐야 하는데, `kis-orders`도 그 파일을 고친다 |
| `order-window-reuse` | #13 ① | poteto: 저장된 상태(`orderEntries`)를 지운다 | 바로 시작. `stores/`만 고치고 새 e2e 파일을 쓴다 |
| `order-ledger` | #10 ①②, #13 ② | poteto: 주문을 보내는 장부와 보내는 중 상태, 응답 순서를 다룬다 | `kis-orders` 뒤. `web/src/features/order/**`와 주문 e2e를 둘 다 고친다 |
| `kiwoom-token-owner` | #15 1~4, #27 키 5개 제한 | poteto: 토큰·차단 기록의 저장과 인증이다 | `kis-orders` 뒤. `crates/server/src/kiwoom/**`와 `crates/server/tests/**`가 겹친다 |
| `kis-rest-edges` | #19 코드 항목, #20 ①② | poteto: 시세 데이터 경계와 API 타입이 바뀐다 | `kis-orders` 뒤. `crates/server/src/kis/**`, `web/src/api/**`, `web/e2e/fixtures/**`가 겹친다. `kis-orders`는 `source-select-web`(`features/market-page/**`) 뒤라 그것도 먼저 들어간다 |
| `source-switch-edges` | #24, #25, #26, #27 갱신 거절 | poteto: 공급원 전환의 동시성, 공개 모드 계수다 | `kis-orders`와 `source-switch-caches` 뒤. 둘 다 `market_source/switch.rs`·`tests/source_switch.rs`·`kis/**`를 고친다 |

- `ladder-gap-narrow`, `order-ledger`, 서버 세 작업은 `kis-orders`가 병합되면 함께 돈다. 서로 겹치는 파일은 아래 `shared`뿐이다.
- 서버 세 작업이 함께 닿는 파일은 `shared`에 적었다(`crates/server/src/kis/mod.rs`, `crates/server/src/app.rs`). 지시서에 최소 변경으로 하라고 적었다.
- `ladder-gap-narrow`와 `order-ledger`는 `web/e2e/win-order-panels.spec.ts`에 각자 몇 줄만 더하거나 고친다. 두 작업의 `shared`에 적고 지시서에 최소 변경으로 하라고 적었다. 둘은 그 밖의 파일이 겹치지 않아 함께 돈다.
- `order-window-reuse`는 `web/e2e/win-order-panels.spec.ts`(`kis-orders`가 고친다)를 고치지 않는다. 돌려서 확인만 하고, 새 시험은 새 spec 파일 `web/e2e/order-window-reuse.spec.ts`에 둔다. 그래서 지금 바로 돈다.

## 범위 밖

- 한투 키만으로 스크리너 실행(오늘 요약 경로). source-select-server에서 사용자가 별도 후속 플랜으로 정했다.
- 공급원 전환 때 히트맵 시세·흐름, 공개 모드 시장 캐시 비우기. `source-switch-caches`가 한다.
- kis-overview 보고의 나머지: 기간 수급을 날마다 한 번씩 받는 성능(60일이면 60회), `MarketOverview::choose` 중 옛 공급원 행(source-select-server가 세대 번호로 막음), `kiwoom_starts_later` 이름.
- kiwoom-keys 보고 5·6(시험하지 않은 동시 호출·저장 실패, 시세 키 교체 중 받던 토큰 버림).
- source-select-server 보고의 문서 표기 불일치, e2e 고정값 `rankingKinds`.

## 실사용 확인 목록

실제 한투 응답으로만 확인할 수 있어 작업에 넣지 않았다. 병합 뒤 실제 키로 한 번씩 본다. 근거는 [ADR 0039](../adr/0039-kis-key-and-token-are-vally-only.md)(시장 개요 개정 줄 포함), [ADR 0040](../adr/0040-kis-source-builds-minute-bars-from-one-minute-bars-and-reads-the-symbol-master-file.md)의 "실측하지 않았다"다.

- 분봉 시각이 그 분의 시작인지 끝인지
- 일봉 수정주가 값(`FID_ORG_ADJ_PRC` `0`)이 수정주가를 주는지, 한투 분봉이 권리락에 수정되는지
- 당일 체결의 매수·매도 방향(지금은 호가로 추정)
- 마스터 파일 꼬리 길이(227/221)와 줄바꿈 처리
- 과거 분봉의 `NX`·`UN`·`FID_PW_DATA_INCU_YN`, 여러 종목 현재가의 `UN`
- 프로그램매매·투자자 금액 단위(백만원)
- 지수 일봉 한 쪽의 행 수(50인지 100인지), 지수 현재가 종목 수 칸이 비어 오는 때가 있는지
- `FHPTJ04030000`·`FHPTJ04040000`의 구분 코드, 업종 코드 재사용, 추정 입력 구분 순서, 오늘 행 확정 시각

## 사용자가 정해야 하는 결정

1. **순서.** `ladder-gap-narrow`, `order-ledger`와 서버 세 작업은 `kis-orders` 뒤에 둔다. `kis-orders`가 `web/src/features/order/**`, `crates/server/src/{kis,kiwoom,trading}/**`, `crates/server/tests/**`를 넓게 고치기 때문이다. `kis-orders`는 아직 시작 전이고 `source-select-web` 뒤다. 이 다섯을 더 빨리 하려면 `kis-orders`의 `after`에 이 작업들을 넣어 순서를 뒤집어야 한다. 그 순서는 오케스트레이터가 `kis-orders`를 고쳐야 바뀐다. 기본안은 이 플랜대로 `kis-orders` 뒤다.
2. **같은 시각에 쓰는 다른 플랜.** 같은 탭에 `collector-kis` 플랜 초안이 함께 쓰이고 있다. 이 플랜을 검사할 때는 그 작업들이 아직 계획에 없어 겹침을 보지 못했다. `plan load` 순서에 따라 겹치면 뒤에 들어오는 쪽이 `after`를 둔다.
3. 검증을 약하게 하는 작업(시험 삭제, 시간 제한 증가, `paths` 축소)은 없다.
