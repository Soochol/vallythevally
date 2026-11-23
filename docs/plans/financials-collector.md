# 재무자료 수집을 수집기로 옮기고 서버는 읽기만 한다 (financials-collector)

작성일 2026-11-23. 승인 시점의 기록이며 구현 중 바뀐 것은 반영하지 않는다.

코드 사실의 기준은 `origin/main` `025c6d9b`(#812)다. 방향은 [ADR 0045](../adr/0045-desktop-app-runs-a-personal-engine-and-the-server-keeps-login-and-shared-data.md)와 [ADR 0043](../adr/0043-collector-makes-shared-data-and-the-server-only-reads-it.md)이다. 사용자는 성능을 가장 중요하게 본다.

## 사용자가 풀려는 문제

사용자의 말(2026-11-23): "서버pc에서 서빙하는것과, 사용자 pc에서 서빙하는것이 다르다. 이 프로젝트 컨셉은 N개 증권사, N개 계좌를 지원한다. 빠진 내용 현재 재무자료 이건 사용자 화면에서 빠지고 그리고 데이터수집기 데몬으로 기능을 이관 필요. 현재까지 만들어진 데이터도 서버로 업데이트 필요, 아마 현재 pc가 재무자료가 더 많을거야."

재무자료(OpenDART)는 사용자 키와 상관없는 공용 자료다. 그런데 지금은 `vally-server`가 모은다(`crates/server/src/financials/`, 매일 07:00 자동, 화면의 업데이트 버튼과 진행 창). 서버 PC는 공용 서버, 사용자 PC는 개인 엔진이 되므로(ADR 0045) 재무 수집은 서버 PC의 수집기가 맡고, 서버와 개인 엔진은 저장된 재무자료를 읽기만 해야 한다. 사용자는 개발 PC에 더 많이 모인 자료를 서버 PC에 올리고 싶어 한다.

## 조사한 것 (2026-11-23, 읽기 전용)

### 개발 PC 자료는 이미 서버 PC에 다 있다

두 PC의 `~/vally-data/server/financials.db`를 읽기 전용으로 열어 회사 재무 기록(`companies` 표)을 회사·보고서 키(`<사업연도>/<보고서 코드>`)로 맞대었다. 서버 PC는 수집 중이라 한 번에 한 행씩 짧게 읽었다(쓰기 잠금을 오래 막지 않도록).

| 항목 | 개발 PC | 서버 PC | 개발 PC에만 | 서버 PC에만 |
|---|---|---|---|---|
| 회사 기록 | 2,638 | 2,639 | 0 | 1 |
| 재무제표가 있는 보고서 | 65,573 | 84,123 | **0** | 18,550 |
| 확인을 마친 보고서 | 77,020 | 103,454 | **0** | 26,434 |
| 배당이 있는 보고서 | 15,655 | 21,073 | **0** | 5,418 |

- 서버 PC에만 있는 재무제표 18,550건은 2015~2022년(과거 단계)이 거의 전부다. 서버 PC가 11-20부터 과거 단계를 이어 모은 몫이다.
- 서버 PC 파일은 개발 PC 파일과 크기가 바이트까지 같다(77,229,539,328). 서버 PC에 `financials.db.empty-20261120-003108`이 남아 있다. 2026-11-20 00:31에 개발 PC 파일을 복사해 간 것이다. 개발 PC 파일의 마지막 수정은 11-19 13:25, 마지막 공시 확인은 11-19 08:27이다. 서버 PC의 회사 기록 2,639건은 모두 그보다 나중에 확인됐다.
- 오케스트레이터가 잰 "개발 PC에만 22,770행"은 `financial_requests` 표의 행이다. 이 표는 회사 재무 기록이 아니라 **한 작업 세대 안의 응답 일지**다. 키 `job`은 `<작업 번호>/<세대>`이고(`updates.rs`의 `journal()`), 세대가 바뀌면 `begin_requests`가 다른 세대의 행을 모두 지운다(`store.rs:51`). 세대는 매일 07:00 다시 확인할 때 오른다(`recheck_targets`). 개발 PC의 행은 모두 세대 `1/7`의 것이고, 서버 PC는 `1/8`로 넘어갈 때 같은 행을 지웠다. 모은 결과는 일지가 아니라 `companies`에 저장되고, 다음 수집은 그것을 다시 쓴다.

결론: 합칠 자료가 없다. 개발 PC에만 있는 것은 이미 끝난 세대의 일지뿐이고 서버가 읽거나 다시 쓰지 않는다.

### 77GB의 대부분은 빈 페이지다

| | 개발 PC | 서버 PC |
|---|---|---|
| 페이지 크기 × 수 | 4,096 × 18,854,868 | 같음 |
| 빈 페이지(freelist) | 9,146,627 (37.5GB) | 14,382,567 (**58.9GB**) |
| 쓰는 페이지 | 39.8GB | **18.3GB** |
| 회사 기록 본문 합계 | 7.2GB | 9.1GB (중앙값 3.8MB, 상위 10% 5.8MB, 최대 10.7MB) |
| 일지 | `1/7` 40,205행 | `1/11` 31,524행 |
| `journal_mode` / `auto_vacuum` | delete / 0 | delete / 0 |

- 세대가 바뀔 때 지운 일지 행의 페이지는 freelist로 가고, `auto_vacuum`이 꺼져 있어 파일은 줄지 않는다. 77GB는 개발 PC에서 일지가 가장 컸던 때의 높이이고, 복사로 서버 PC에 그대로 왔다. 일지에는 XBRL 압축 내용(`fnlttXbrl`)까지 문자열로 들어가 한 세대의 일지가 수십 GB가 된다(개발 PC `1/7`이 약 32GB).
- 서버 PC SSD(`/dev/sda2`)는 216GB가 비어 있다. 개발 PC 루트는 92%를 쓰고 80GB가 비어 있다.

### 읽기와 쓰기가 서로 막는다

- 저장소는 롤백 저널(`delete`)이다. 쓰는 동안 읽기를 막고, 읽는 동안 쓰기 확정을 막는다. 서버 PC에서 대기 2초로 한 행을 읽다가 `database is locked`가 한 번 났다. 쓰는 쪽이 잠금을 2초 넘게 쥔 때가 있다는 뜻이다. sqlx의 기본 대기는 5초이고, 넘으면 `Failure::Storage`다. 지금은 한 프로세스 안이라 연결 하나(`max_connections(1)`)로 줄을 서지만, 수집과 읽기를 두 프로세스로 나누면 차트 조회가 수집의 큰 쓰기를 기다리게 된다.
- WAL이면 읽기와 쓰기가 서로 막지 않는다. 읽기는 마지막 확정본을 본다.

### 지금 코드

- 재무 수집은 `Financials`(`financials/mod.rs`) 하나가 한다. OpenDART `Client`가 있으면 수집하고, 없으면 조회만 하며 상태는 `not_configured`다(`read()`의 `self.client.is_none()`). 진행 상태(`collecting`, 회사별 실패)는 프로세스 메모리(`UpdateControl`)에 있고, 작업·일시정지·중단은 같은 DB의 `financial_update`·`financial_update_control`·`financial_stop` 표에 있다.
- 서버는 `app.rs`에서 `OPENDART_API_KEY`가 있으면 수집하고, `VALLY_FINANCIAL_AUTOMATIC`이 켜져 있으면 07:00 자동 확인을 띄운다. 대상 종목은 서버의 종목 목록(`SymbolDirectory`, 키움 `ka10099`)이다. 서버 PC의 `server.env`에 `OPENDART_API_KEY`가 있다(이름만 확인했다).
- 라우트(`financials/routes.rs`): `GET/POST /api/financial-update`, `POST .../pause`, `POST .../resume`, `GET/POST /api/symbols/{code}/financial-source`, `GET/POST /api/symbols/{code}/financials`. POST 둘은 조회하면서 업데이트를 시작한다. 공개 리스너도 GET 셋을 통과시킨다(`public/kiwoom_guard.rs:373`).
- 화면: `FinancialUpdateButton`이 상단바·관심종목·스크리너·휴대폰 머리에 있고, `FinancialUpdateDialog`, 차트 재무지표 메뉴의 "새로고침"(`ChartCell.tsx:92`), 작업 상태를 1초마다 읽어 차트를 다시 받는 `watchFinancialJob`·`useFinancialJob`이 있다. 시스템 설정은 `재무자료 자동 수집`, `재무 데이터베이스`, `OpenDART 키`를 읽기 전용으로 보인다.
- 수집기는 이미 `server` 크레이트에 기대므로 `server::financials`를 그대로 쓸 수 있다. 감독 데몬은 07:20에 종목 목록을 `<--data>/universe/<YYYYMMDD>.json`에 쓴다(코스피·코스닥 보통주·우선주·스팩. 서버의 `SymbolKind::Common`은 스팩을 포함한다). 데몬은 마감 정리 뒤에만 재시작한다(ADR 0026, `docs/server-operations.md` "수집 데몬 재시작").
- `dart-smoke`(`crates/server/src/bin/dart-smoke.rs`)와 `scripts/live.py`는 격리된 DB로 실제 OpenDART를 부르는 수동 확인 도구다. `Financials::new`와 조회 라우트를 쓴다.

## 확정된 것

1. 재무자료는 공용 자료다. 수집은 서버 PC의 수집기가 하고, `vally-server`(공용 서버이자 앱의 개인 엔진)는 저장된 재무자료를 읽기만 한다.
2. 사용자 화면에서 재무 업데이트 조작과 진행 화면을 뺀다. 차트 재무지표 보기는 남는다(요청의 해석. 다르게 볼 근거는 찾지 못했다).
3. 서버 PC에서의 실행(전환, 배포, 데몬 재시작)은 사용자 승인 뒤 오케스트레이터가 한다. 작업자는 코드, 시험, 절차서까지만 만든다.
4. 서버 PC의 비밀값(OpenDART 키)은 이름만 다루고 값을 출력하지 않는다.

## 스스로 정한 것

- **D1 합치기 도구를 만들지 않는다.** 위 대조에서 개발 PC에만 있는 회사 재무 기록은 0건이다. 일지 행은 끝난 세대의 것이라 옮겨도 다음 세대 시작에서 지워지고, 그 전에도 서버가 키(`1/11`)가 달라 읽지 않는다. 도구를 만들면 시험과 절차만 늘고 자료는 한 건도 늘지 않는다. 개발 PC 파일을 어떻게 할지는 사용자 결정 U3이다.
- **D2 수집 코드는 `crates/server/src/financials/`에 두고, 돌리는 곳만 옮긴다.** 수집기가 이미 `server`에 기대므로 코드를 옮길 까닭이 없다. 옮기면 약 3,000줄과 시험 약 4,000줄이 자리만 바뀐다. 조회 계산(`calculate.rs`, `company_records.rs`)은 서버가 계속 쓴다.
- **D3 수집은 수집기 바이너리의 별도 프로세스 `collector financials run`이 한다.** 감독 데몬의 자식이 아니다. 유닛 `vally-financials.service`가 `PartOf=vally-collector.service`로 데몬과 함께 멈추고 다시 뜬다. 이유:
  - OpenDART는 키움 키, 토큰, 관측일 일정이 필요 없다. 휴장일과 주말에도 07:00에 확인하고 과거 단계는 며칠씩 이어진다. 관측일마다 띄우고 거두는 데몬 자식 모델과 맞지 않는다.
  - 프로세스가 따로라 재무 수집의 panic이나 큰 쓰기가 실시간 수집을 멈추지 않는다.
  - 같은 바이너리(`~/.local/bin/collector`)와 `PartOf`를 쓰므로 배포 규칙이 데몬과 같다. `collector-install`이 수집 시간 안에는 `.next`에 두고 `collector-restart`가 마감 뒤 데몬을 다시 띄우면 재무 프로세스도 새 판으로 뜬다. 새 배포 스크립트와 `deploy.json` 변경이 없다.
  - 데몬 코드(`supervise/`, 줄 JSON 프로토콜 버전)를 건드리지 않아 실행 중인 `collector-rankings`·`collector-overview`와 부딪치지 않는다.
  - 운영자는 언제든 `systemctl --user restart vally-financials`로 다시 띄울 수 있다. 수집은 일지로 이어진다(ADR 0015의 "다음 기동 때 수행").
- **D4 쓰는 쪽은 하나다.** 업데이트를 띄우는 `Financials`는 DB 옆 잠금 파일(`<DB>.writer.lock`)을 배타로 쥔다. `collector financials run`은 시작할 때 쥐고, 못 쥐면 종료 코드 2로 끝난다. 서버는 처음 업데이트를 띄울 때(자동·시작·재개) 쥐고 프로세스가 끝날 때까지 놓지 않는다. 못 쥐면 그 업데이트를 띄우지 않고 경고를 남긴다. 서버가 시작할 때 쥐지 않는 까닭은 전환 2단계에서 자동 확인만 끈 서버가 잠금을 쥐고 있으면 6단계의 수집기가 뜨지 못하기 때문이다. 전환 기간에 옛 업데이트 버튼이나 두 번째 `run`이 같은 작업 상태와 일지를 번갈아 지우는 일을 막는다.
- **D5 저장소는 WAL로 바꾼다.** 쓰는 쪽이 열 때 `journal_mode=WAL`을 건다(파일에 남는다). 읽는 쪽(서버)은 읽기 전용으로 열고 쓰기를 기다리지 않는다. 회사 기록 하나가 최대 10.7MB라 롤백 저널에서는 차트 조회가 그만큼의 쓰기를 기다린다.
- **D6 대상 종목은 데몬의 종목 목록 파일에서 읽는다.** 재무 프로세스는 키움 키를 갖지 않는다. 오늘 파일이 없으면(휴장일, 07:20 전) 가장 최근 파일을 쓴다. 하나도 없으면 OpenDART를 부르지 않고 상태에 "종목 목록 없음"을 보인다. 스팩은 서버와 같이 보통주로 본다. 서버의 종목 목록에 있던 ETF·ETN은 어차피 `unsupported`였으므로 자료가 달라지지 않는다.
- **D7 OpenDART 키는 서버 PC의 파일 `~/.config/vally/opendart-key`(권한 600)에 둔다.** `--holiday-key`와 같은 방식이다. 권한이 600이 아니면 시작하지 않는다. 서버의 `server.env`에서는 전환 뒤 지운다.
- **D8 운영자는 CLI와 텔레그램으로 본다.** `collector financials status|start|pause|resume`이 재무 프로세스의 unix socket(`<state>/financials.sock`, 권한 600)으로 묻는다. 출력은 지금 진행 창의 내용(`FinancialUpdatePage`)이다. 운영자 조치가 필요한 상태(인증 중단, 저장 실패, 호출 한도 중단)로 바뀌면 데몬과 같은 텔레그램 설정(`server::collector::telegram`)으로 한 번 알린다. 운영자 리스너의 시스템 설정 상태판에 싣는 일은 후속으로 둔다(U6).
- **D9 서버의 조회는 저장 자료로만 상태를 정한다.** 수집 중인지는 다른 프로세스의 메모리라 서버가 모른다. `collecting` 대신 저장 자료의 `ready`·`stale`·`partial_failure`·`not_collected`를 쓴다. DB 파일이 없으면 `not_configured`(이 서버에 재무자료가 없음)다. 앱의 개인 엔진은 DB가 없으니 `not_configured`가 되고, 공용 서버에서 받아 오는 일은 desktop-app 플랜의 "다음 단계 1"이 한다.
- **D10 전환 때 압축한 사본으로 바꿔 끼운다**(사용자 결정 U4로 확인). 절차는 아래 "전환 절차"다.
- **D11 개인 엔진의 재무 수집이 꺼지는 것은 `fin-server-read`로 끝난다.** 개인 엔진이 지금 서버 코드이므로 서버에서 수집을 걷으면 엔진에서도 걷힌다. desktop-app 플랜의 `engine-split-design`은 취소됐으니 맞출 상대가 없다.

## 작업

| 작업 | 방식 | 이유 | 순서 |
|---|---|---|---|
| `fin-collector` | poteto | 새 프로세스, 잠금, 저장 형식(WAL), 여러 모듈에 걸친 설계, 배포 스크립트 | 지금 시작 |
| `fin-server-read` | poteto | 서버의 저장소 열기·설정·라우트와 화면을 함께 걷는다. 상태 저장과 여러 모듈 | `fin-collector`, `rankings-overview-shared`, `web-shared-age`, `public-guards-off`, `public-web-retire` 뒤 |

### `fin-collector`

- `server::financials`: 쓰는 쪽 잠금(D4), WAL(D5), 대상 종목을 바깥에서 받는 자동 확인(지금 `start_automatic`은 `SymbolDirectory`를 받는다). 서버의 동작은 잠금 말고는 바뀌지 않는다(`app.rs`는 `start_automatic` 호출 모양만 맞춘다).
- `collector financials run|status|start|pause|resume`(새 `crates/collector/src/financials/`), 유닛 `deploy/systemd/vally-financials.service`, `collector-install`이 그 유닛도 바꾸게 하고 시험(`scripts/test-deploy-scripts.py`).
- 문서: 새 ADR(재무 수집은 수집기, 서버는 읽기), ADR 0015 개정 줄, 용어집의 "재무자료 업데이트 중단"(사용자 일시정지 → 운영자 일시정지), `docs/hoga-collector.md`의 재무 프로세스 절, `docs/server-operations.md`의 설치와 "재무 수집 전환" 절차.

### `fin-server-read`

- 서버: 재무 저장소를 읽기 전용으로만 열고 `Client`와 자동 확인을 만들지 않는다. 라우트는 `GET /api/symbols/{code}/financial-source`와 `GET /api/symbols/{code}/financials`만 남긴다. 설정 `OPENDART_API_KEY`·`VALLY_FINANCIAL_AUTOMATIC`·`VALLY_DART_BASE_URL`을 서버에서 걷고, 남아 있으면 무시하고 경고 한 줄을 남긴다. 시스템 설정의 `financialAutomatic`·`opendartKeyPresent`를 뺀다.
- 화면: 업데이트 버튼·창, 차트 재무지표 메뉴의 "새로고침", 작업 상태 읽기와 1초 재요청, 시스템 설정의 `재무자료 · DART` 메뉴와 두 줄을 뺀다.
- 시험: 서버 시험의 업데이트 라우트 호출을 `Financials` 메서드 호출로 바꾼다(수집 규칙 시험은 남긴다). 걷은 화면을 시험하던 e2e를 지우고 남는 재무 e2e를 고친다.

### 순서를 둔 이유

- `fin-server-read`는 `fin-collector` 뒤다. 서버에서 수집을 걷기 전에 수집기가 수집할 수 있어야 한다. 전환(아래)은 `fin-collector` 배포 뒤 바로 할 수 있고, `fin-server-read`는 그 뒤의 정리다.
- `fin-server-read`는 `rankings-overview-shared`(`crates/server/src/api.rs`), `web-shared-age`(`web/src/**`, `web/e2e/**`), `public-guards-off`(`crates/server/tests/public_listener.rs`), `public-web-retire`(`web/src/engine/**`, `public_listener.rs`) 뒤다. 같은 파일을 고친다. 사슬이 길어 늦게 시작하지만, 전환은 `fin-collector`만으로 되므로 수집 이관이 기다리지 않는다. `fin-server-read`는 서버 쪽 정리다. `fin-collector`는 `crates/server/src/financials/**`, `app.rs`, `crates/collector/src/financials/**`, `main.rs`·`lib.rs`, 배포 파일, 문서만 고쳐 이 탭의 다른 작업과 겹치지 않는다.
- `public/kiwoom_guard.rs`의 허용 목록에 `GET /api/financial-update`가 남는다. 라우트가 없어지면 404라 해가 없다. `public-guards-off`(`crates/server/src/public/**`)와 부딪치지 않으려고 이 플랜은 그 파일을 고치지 않는다. 지우는 일은 `public-guards-off`나 `public-web-retire`가 한 줄로 한다.

## 전환 절차 (승인 뒤 오케스트레이터가 서버 PC에서)

`fin-collector`가 `docs/server-operations.md`에 명령까지 적는다. 순서와 판단만 여기에 둔다.

1. `fin-collector`를 배포한다(서버 재시작, 수집 바이너리 설치. 이 단계에서 재무 유닛은 아직 설치하지 않는다).
2. 서버의 자동 확인을 끈다. 유닛 드롭인으로 `VALLY_FINANCIAL_AUTOMATIC=off`를 넣고 서버를 다시 띄운다. 진행 중이던 작업은 `interrupted`로 남고 일지(`1/11`)는 그대로다. 이제 아무도 DB에 쓰지 않는다.
3. 압축 사본을 만든다: `VACUUM INTO '<DB>.compact'`. 쓰는 쪽이 없으므로 서버의 차트 조회는 계속된다. 약 18GB를 읽고 쓴다. 만든 뒤 사본에 `PRAGMA integrity_check`, 표마다 행 수와 원본 대조.
4. 바꿔 끼운다: 원본을 `financials.db.before-collector`로 이름을 바꿔 남기고 사본을 `financials.db`로 옮긴 뒤 서버를 다시 띄운다(옛 파일을 열고 있으므로).
5. 키 파일을 만든다: `server.env`의 `OPENDART_API_KEY` 값을 화면에 내지 않고 `~/.config/vally/opendart-key`(600)로 옮긴다.
6. 재무 유닛을 설치하고 켠다. 새 `collector`가 제자리(`~/.local/bin/collector`)에 들어간 뒤여야 한다. 수집 시간 안에 배포했으면 마감 뒤 데몬 재시작이 `.next`를 옮긴 다음에 한다. 처음 설치는 손으로 한다(`collector-install`은 이미 설치된 유닛만 바꾼다). 첫 `run`이 WAL로 바꾸고, 자동 확인이 `interrupted` 작업을 같은 세대로 이어 간다. `collector financials status`로 작업 번호·세대가 전과 같은지, 회사 수가 늘어나는지 본다.
7. 확인: 표본 종목 몇 개(예: 005930, 000660, 우선주 005935)의 `GET /api/symbols/<code>/financials?period=Y`·`Q` 응답을 2단계 전과 6단계 뒤에 받아 같은지 본다(수집이 그 회사를 바꾸기 전이라면 같아야 한다).
8. `fin-server-read` 배포 뒤 `server.env`에서 `OPENDART_API_KEY`를 지우고 드롭인을 걷는다.

되돌리기: 재무 유닛을 멈추고(`systemctl --user disable --now vally-financials`) 드롭인을 걷어 서버를 다시 띄우면 서버가 같은 파일로 다시 수집한다. 형식이 같으므로 옛 파일로 돌아갈 필요가 없다. 파일이 깨졌을 때만 `financials.db.before-collector`로 돌아간다. `fin-server-read`가 배포된 뒤의 되돌리기는 그 커밋을 되돌린 배포다.

공간: 원본 77GB + 사본 약 18GB. 서버 PC에 216GB가 비어 있다.

## 범위 밖

- 재무지표로 스크리너 조건을 거는 일(ADR 0015의 후속).
- 앱의 개인 엔진이 공용 서버에서 재무자료를 받아 오는 일(desktop-app 플랜 다음 단계 1).
- 재무 저장 형식의 성능 개선(U7).
- 키움 약관·재배포·규제.

## 받아들일 한계

- 서버는 "지금 이 회사를 모으는 중"을 모른다. 차트는 저장 자료의 `stale`로 보인다.
- 전환 2~6단계 사이에는 재무를 모으지 않는다. 몇십 분이다.
- 전환 뒤 `fin-server-read`가 배포되기 전까지 화면의 업데이트 창이 남는다. 창은 수집기가 쓰는 작업을 `interrupted`로 보일 수 있고, 버튼을 눌러도 잠금 때문에 업데이트가 뜨지 않는다. 운영자는 `collector financials status`로 본다.
- 재무 코드의 수정은 데몬과 같이 마감 뒤에 켜진다. 급하면 운영자가 `.next`를 옮기고 재무 유닛만 다시 띄울 수 있으나 기본 절차에는 넣지 않는다.
- VACUUM 뒤에도 다음 세대의 일지가 쌓이면 파일이 다시 커진다. 개발 PC의 `1/7`처럼 한 세대가 약 32GB까지 갈 수 있다. 근본 해결은 U7이다.

## 사용자가 정해야 하는 결정

구현을 막는 결정은 없다. 모두 권장안으로 짓는다.

- **U1 재무 수집이 도는 곳** (권장: 수집기 바이너리의 별도 프로세스와 유닛, `PartOf`로 데몬과 함께 재시작. D3). 다른 안: 감독 데몬의 자식. 데몬 상태 API와 경보를 그대로 쓰지만, 관측일 밖에도 사는 자식 종류를 데몬에 새로 넣어야 하고 데몬 코드가 크게 바뀐다.
- **U2 합치기 도구** (권장: 만들지 않는다. D1). 다른 안: 그래도 만든다. 대조 결과 옮길 자료가 0건이다.
- **U3 개발 PC의 `~/vally-data/server/financials.db`(77GB)** (권장: 서버 PC 전환과 확인이 끝나면 지운다. 개발 PC 디스크가 92%다). 지우기 전 같은 대조를 한 번 더 할 수 있다. 대조 스크립트는 플랜 초안 폴더의 `compare-financials.py`에 있다(서버 PC는 한 행씩 읽는다).
- **U4 전환 때 VACUUM으로 줄이기** (권장: 한다. 58.9GB를 돌려받고 백업·복사가 18GB가 된다. 쓰는 쪽이 없는 2~4단계에 하므로 서버 조회를 막지 않는다). 다른 안: 하지 않는다. 빈 페이지는 다음 일지가 다시 쓴다.
- **U5 다른 탭 작업과의 순서.** 다른 탭의 증권사 작업 가운데 `crates/server/src/{app,config,api,system_routes}.rs`나 `web/src/features/system-settings/**`를 고치는 작업이 있으면, `fin-server-read`는 그것이 병합된 뒤 시작하기를 권한다(탭이 달라 `after`로 걸 수 없다). `fin-collector`의 `app.rs` 변경은 몇 줄이다.
- **U6 운영자 상태판** (권장: 이번에는 CLI와 텔레그램만. D8). 다른 안: 운영자 리스너의 시스템 설정 수집 상태판에 재무 프로세스 상태를 싣는 후속 작업.
- **U7 재무 저장 형식의 성능 플랜을 따로 짤지** (권장: 짠다). 추정이고 측정이 아니다:
  - 회사 기록은 보고서 하나를 모을 때마다 JSON 전체(중앙값 3.8MB, 최대 10.7MB)를 다시 쓴다. 회사마다 과거 단계에 보고서 32건 × 2~4번 저장이면 0.25~0.5GB, 2,639곳이면 한 바퀴에 약 0.6~1.3TB를 쓴다.
  - 일지가 끝난 보고서의 XBRL 원문까지 세대 끝까지 들고 있어 파일 높이를 수십 GB로 올린다.
  - 보고서 단위 행으로 나누고 끝난 보고서의 일지를 지우는 안을, 쓰기 양을 잰 뒤 정한다.
- **검증을 약하게 하는 작업**: `fin-server-read`가 업데이트 화면의 e2e(`financial-update`, `financial-stop`, `financial-schedule` 등)와 업데이트 라우트 시험을 지운다. 기능이 없어지기 때문이다. 정지·재개·일정 규칙은 `crates/server/tests/financials/**`(메서드 호출로 바꿔 남긴다)와 `fin-collector`의 소켓 시험이 계속 확인한다.
