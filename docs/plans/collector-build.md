# 데이터 수집 앱(감독 데몬) 구현 플랜

작성일: 2026-11-17. 승인 시점의 기록이며 구현 중 바뀐 것은 반영하지 않는다.

## 풀려는 문제

사용자는 [ADR 0026](../adr/0026-collector-supervisor-collects-common-and-preferred-stocks.md)(일부는 [ADR 0025](../adr/0025-collector-stores-closed-days-for-the-app.md))대로 데이터 수집 앱을 만들려 한다. 코스피·코스닥의 보통주와 우선주(스팩 포함)를 날마다 모두 모으는 앱이다. 감독 데몬 하나가 수집 키마다 자식 프로세스를 띄우고, 마감 뒤에 원문을 Parquet으로 정리한다. 수집 관리 계정은 앱 브라우저의 수집 현황판에서 상태를 본다.

지금 `crates/collector`는 프로토타입이다. 키 하나로 동작하고, 받는 타입은 넷(`0B`·`0D`·`0w`·`0F`)이다. `build`는 하루치를 메모리에 올려 brotli q11 구간 파일을 만들고, 복기 화면은 `collector serve`가 띄운다. 이 플랜은 그 프로토타입을 ADR 0026의 구성으로 넓히는 작업을 PR 단위로 나눈다.

## 확정된 결정 (사용자와 정함)

- 키움 키는 필요한 만큼 나중에 확보한다고 본다.
- 대상은 코스피·코스닥의 보통주와 우선주이고 스팩도 넣는다. ETF·ETN·리츠는 넣지 않는다.
- 매일 아침 `ka10099`로 전 종목을 받아 대상만 남기고, 그 종목을 키에 나눈다.
- 감독 데몬 하나가 키마다 자식 프로세스를 띄운다(B안). 데몬은 죽지 않는다고 본다.
- 수집 현황판은 앱 브라우저의 페이지이고, 수집 관리 계정만 본다.
- 관측일은 특일정보 API, KRX 고정 휴장일, 사람이 고치는 수정 파일로 정한다. 장중에는 `0s`로, 마감 뒤에는 지수 일봉으로 대조한다.
- 등록 한도 200은 앱키마다다(사용자가 검증).
- 데몬이 받은 실시간 시세를 앱으로 흘려 보내지 않는다.
- 데이터 수집은 앱 서버(`vally-server`)에 넣지 않고 별도 프로세스로 둔다.
- 앱과 데몬은 같은 PC에 있다고 본다.

## 스스로 정한 결정과 이유

1. **첫 단계는 WebSocket 수집, 정리, 현황판까지다.** REST 작업과 앱의 복기(Parquet 조회 API와 화면)는 이 플랜에 넣지 않는다. [수집기 REST 작업 표](../collector-rest-jobs.md)의 TR은 아직 하나도 불러 보지 않았고, 장중 주기와 변형도 정하지 않았다(ADR 0025 "REST 작업의 세부"). 복기 API는 실제 하루치 Parquet이 생긴 뒤에 열 계약을 맞춰 보는 편이 낫다. 다만 수집 계획과 현황판에는 REST 작업 자리를 둔다. 지금은 비어 있는 목록이다. 사용자 결정 3에서 바꿀 수 있다.
2. **`collect --items`(혼자 토큰을 받는 모드)를 남긴다.** 자식 모드(`collect --child`)는 따로 더한다. 실측 절차(사용자 결정 2)와 정규장 하루 실측은 데몬이 생기기 전에도 기존 명령으로 돌릴 수 있어야 한다. 두 모드는 세션 코어를 함께 쓰고, 토큰을 어디서 받는지만 다르다.
3. **`build`·`verify`·`serve`는 그대로 둔다.** ADR 0025·0026은 `collector serve`를 앱에 같은 기능이 생기면 없앤다고 했다. 앱 복기가 이 플랜 밖이므로, 원문이 키 폴더(`raw/<날짜>/<키>/`)로 옮겨도 세 명령이 계속 동작하게만 한다. `finalize`는 새 하위 명령으로 둔다.
4. **계획의 부하 입력은 전날 `complete.json`의 종목별 메시지 수로 읽는다.** ADR 0026은 "전날 원문의 종목별 메시지 수"라고 적었다. 그런데 전날 원문은 하루 수십 GB라 07:35에 다시 풀면 무겁다. 그래서 `finalize`가 원문을 읽을 때 종목별 메시지 수를 세어 `complete.json`의 커버리지에 남기고, 계획은 그 값을 쓴다. 값은 같은 원문에서 나온다. 계획 함수는 `종목 → 메시지 수` 맵을 받고, 그 맵을 어디서 읽을지는 하루 일정 작업이 잇는다. 그래서 계획 작업이 정리 작업을 기다리지 않는다.
5. **지수 일봉 대조는 데몬이 예비 키로 부른다.** ADR 0026은 "데몬이 직접 부르는 REST는 07:20과 마감 뒤의 `ka10099`뿐"이라고 적었다. 그런데 같은 ADR의 마감 뒤 지수 일봉 대조에도 REST 호출이 필요하다. 자식에게 맡기면 계획과 인계가 이 호출을 따라다녀야 한다. 그래서 데몬이 마감 뒤 `ka10099`를 부를 때 같은 예비 키로 지수 일봉도 한 번 부르게 하고, ADR 0026의 그 줄은 하루 일정 작업이 고친다. 사용자 결정 4다.
6. **정하지 않은 수치는 설정값으로 두고 기본값을 정한다.**
   - 자식 하트비트: 5초. 15초 동안 오지 않으면 데몬이 그 자식을 멈춘 것으로 본다.
   - 데몬이 커넥터에 보내는 하트비트: 5초. 커넥터는 3번(15초) 잇달아 받지 못하면 "응답 없음"으로 본다.
   - 자식 재시작 간격: 1, 2, 5, 10, 30초이고 끝 값을 계속 쓴다. 지금 세션의 다시 붙기 간격과 같다. 한 키의 재시작 한도는 그날 5회다.
   - 키마다 토큰 발급 간격: 5초. `au10001`을 여러 키에 잇달아 불러도 되는지 아직 모른다(ADR 0026).
   - 원문 지우기까지의 N: 10관측일. ADR 0025의 "2~3주 보관"에 맞춘 값이다. 사용자 결정 5다.
7. **관측일 판단이 "모름"이면 관측일로 보고 돌리고 경보를 낸다.** 특일정보를 받지 못했고 캐시도 없거나, 수정 파일이 깨진 경우다. 받을 날을 놓치면 되찾을 수 없지만, 쉬는 날 헛돌면 토큰 발급과 빈 원문만 생긴다.
8. **경보는 첫 단계에서 로그, 상태 API, 현황판에만 낸다.** `OnFailure=`는 journal에 남기는 유닛으로 둔다. 브라우저 밖 경보처(메일, 메신저)는 ADR 0026에서 아직 정하지 않았다. 사용자 결정 6이다.
9. **상태 API는 문서로 계약한다.** 앱은 수집기 코드를 가져다 쓰지 않는다(ADR 0025). 그래서 `supervise-status` 작업이 `docs/collector-status-api.md`에 형식과 버전을 적고 예시 JSON을 시험 입력으로 둔다. 커넥터는 이 문서와 예시를 보고 자기 타입을 만든다. 현황판에 보일 항목은 모두 이 계약에 처음부터 넣는다. 관측일 판단 근거와 종목 목록 변동처럼 나중 작업이 채우는 값은 비어 있을 수 있게 둔다.
10. **Parquet 형식도 문서로 계약한다.** `finalize-parquet`가 `docs/collector-store-format.md`에 열 이름, 단위, 시각 기준, 거래소 구분, 형식 버전을 적는다(ADR 0025 "수집 저장소").
11. **`PR_SET_PDEATHSIG`는 안전한 래퍼 크레이트로 건다.** 워크스페이스에 `unsafe_code = "forbid"`가 걸려 있다. 그래서 `rustix`·`nix`처럼 안전한 API를 주는 크레이트를 쓴다.

## 작업

| 작업 | 방식 | 이유 | 순서 |
|---|---|---|---|
| `probe-doc` | `basic`, `minor-fix` | 사람이 돌리는 실측 절차 문서 하나다. 코드는 고치지 않는다 | 처음부터 병렬 |
| `domain-listing` | `poteto` | 스크리너와 수집기가 함께 쓸 종목 분류 규칙을 크레이트 사이로 옮긴다. 스크리너 대상 종목이 바뀌면 안 된다 | 처음부터 병렬 |
| `collector-calendar` | `poteto` | 관측일 판단과 휴장일 캐시 파일. 데이터를 쓰고, 새 비밀값(공공데이터포털 서비스 키)을 다룬다 | 처음부터 병렬 |
| `collector-child` | `poteto` | 세션 코어를 다시 짜고, 프로세스 사이 프로토콜과 부모 종료 신호를 다룬다 | 처음부터 병렬 |
| `finalize-parquet` | `poteto` | 원문을 Parquet으로 정리하고 대조한다. 데이터 형식 계약과 병합 스레드를 다룬다 | 처음부터 병렬 |
| `collector-universe` | `poteto` | 수집 종목 목록 파일과 전날 대비 검사. 데이터를 쓴다 | `domain-listing` 뒤. 그 규칙을 쓴다 |
| `collector-plan` | `poteto` | 키 목록 설정(비밀값 경로)과 수집 계획 파일. 한 종목이 한 키에만 든다는 불변식을 지킨다 | `collector-universe` 뒤. 종목 목록 타입을 입력으로 쓴다 |
| `supervise-core` | `poteto` | 상주 데몬, 자식 프로세스, 토큰 발급, 재시작, 인계. 동시성과 상태 저장이다 | `collector-child`·`collector-plan` 뒤. 자식 프로토콜과 계획을 쓴다 |
| `supervise-status` | `poteto` | unix socket 상태 API(권한 600)와 하트비트, `collector status` | `supervise-core` 뒤. 데몬 상태를 내보낸다 |
| `finalize-complete` | `poteto` | 커버리지, `complete.json`, 다시 정리할 때 폴더 갈아 끼우기, 원문 지우기 | `finalize-parquet`·`supervise-core`·`collector-calendar` 뒤. Parquet 정리, 인계 기록, 관측일 셈을 쓴다 |
| `supervise-schedule` | `poteto` | 하루 일정과 `0s`·지수 일봉 대조. 데몬의 같은 실행 흐름을 다시 짠다 | `supervise-status`·`finalize-complete`·`collector-universe`·`collector-calendar` 뒤. 상태 API에 판단 근거를 채운다 |
| `collector-ops` | `basic`, `minor-fix` | systemd 유닛과 운영 문서 | `supervise-schedule`·`probe-doc` 뒤. 완성된 `collector supervise`를 띄우고, 실측 문서를 가리킨다 |
| `connector-collector-api` | `poteto` | 커넥터의 `/api/collector/*`, 수집 관리 계정 허용 목록(인가), 데몬 감시 | `supervise-status` 뒤. 상태 API 계약을 읽는다 |
| `web-collector-board` | `poteto` | 앱 브라우저의 새 페이지, 권한에 따른 메뉴, 경고와 브라우저 알림 | `connector-collector-api` 뒤. 그 API와 생성 타입을 쓴다 |

병렬로 처음 뜨는 다섯 작업 가운데 `collector-child`, `finalize-parquet`, `collector-calendar`는 `crates/collector/Cargo.toml`·`Cargo.lock`, `crates/collector/src/lib.rs`, `crates/collector/src/main.rs`, `docs/hoga-collector.md`에 각자 몇 줄씩 더한다. 그래서 세 지시서에 이 파일들은 최소 변경으로 하라고 적었다. `supervise-schedule`은 `supervise-status`와 데몬의 상태 모양을 함께 고치게 되므로 순차로 두었다. `connector-collector-api`와 `supervise-schedule`은 겹치는 파일이 없어 병렬이다.

```
probe-doc
domain-listing ─ collector-universe ─ collector-plan ─┐
collector-child ──────────────────────────────────────┴ supervise-core ─ supervise-status ─┬ connector-collector-api ─ web-collector-board
finalize-parquet ─────────────────────────────────────── finalize-complete ────────────────┴ supervise-schedule ─ collector-ops
collector-calendar ───────────────────────────────────── (finalize-complete, supervise-schedule에 들어감)
```

## 범위 밖

- 수집기의 REST 작업(장중, 마감 뒤). 결정 1과 사용자 결정 3을 본다.
- 앱 서버가 수집 저장소를 읽는 복기 API, 종목 검색 색인, 앱 안의 복기 화면. 그리고 `collector serve`·`build`·`--follow`를 없애는 일.
- 앱 서버의 당일 저장소(ADR 0025 "분담"의 오늘 쪽).
- 브라우저 밖 경보처(메일, 메신저).
- 수집 PC를 여러 대로 나누는 구성. 실측에서 한 IP 세션 15개가 안 되면 새 ADR로 정한다.
- 현황판의 재시작·인계 버튼(ADR 0026이 뺐다).
- 실제 키움 호출. 모든 시험은 합성 transport·세션으로 한다. 실측은 `probe-doc`의 절차대로 사람이 돌린다.

## 사용자가 정해야 하는 결정

1. **PR #475(데몬 감시, 재시작 규칙, `OnFailure=`, 앱키별 등록 한도)를 언제 머지할지.**
   - (A, 권장) 이 플랜을 승인하기 전에 머지한다. `supervise-status`, `connector-collector-api`, `collector-ops`가 그 내용을 구현한다. 그래서 ADR 본문과 지시서가 같은 내용을 가리키게 된다. 지시서에는 그 규칙을 그대로 옮겨 적어 두어서, 머지 순서가 달라도 작업자가 읽을 수 있다.
   - (B) 나중에 머지한다. 그동안 main의 ADR 0026에는 커넥터 감시가 없는데 코드에는 생긴다.
2. **한 IP에서 WebSocket 세션 15개가 되는지를 먼저 잴지.**
   - (A, 권장) 재는 일을 빌드와 함께 진행한다. `probe-doc`이 절차를 쓰고, 사용자가 지금 가진 키로 먼저 잰다. 키를 더 확보하면 다시 잰다. 종목 목록, 관측일, 자식 모드, 정리는 PC 수와 관계없이 필요하다. 한 PC를 가정하는 것은 `supervise-*`뿐이다. 실측이 실패하면 새 ADR로 그 부분만 바꾼다.
   - (B) `supervise-core`부터는 실측 결과가 나올 때까지 띄우지 않는다. 키를 15개 모으기 전에는 15개를 잴 수 없어서 오래 멈출 수 있다.
3. **첫 단계에 REST 작업과 앱 복기를 넣을지.**
   - (A, 권장) 넣지 않는다(결정 1). REST는 TR 세부를 실측한 뒤에, 복기는 실제 Parquet 하루치가 생긴 뒤에 각각 따로 플랜을 세운다.
   - (B) REST 작업 실행기를 넣는다. `collector-plan`이 REST 작업을 나누고, `supervise-core` 뒤에 실행기 작업이 하나 생긴다. TR별 주기와 변형은 사용자가 정해야 한다.
   - (C) 앱 복기도 넣는다. `finalize-complete` 뒤에 앱 서버의 복기 API 작업과 웹 복기 화면 작업이 생긴다.
4. **마감 뒤 지수 일봉 대조를 데몬이 예비 키로 부르게 ADR 0026의 한 줄을 고칠지(결정 5).**
   - (A, 권장) 고친다. `supervise-schedule`이 ADR 0026의 "데몬이 직접 부르는 REST" 줄에 지수 일봉을 더한다.
   - (B) 고치지 않는다. 그러면 대조를 할 곳이 없으므로 이번 단계에서는 마감 뒤 대조를 빼고, 장중 `0s` 대조만 한다.
5. **원문을 지우기까지의 관측일 수 N.** 기본값은 10관측일이다(결정 6). 대조를 통과한 날만 지우고, 그 전에는 지우지 않는다. 하루 원문이 19~34GB로 어림되므로, 10일이면 원문만 190~340GB다. 2026-11-17 기준 남은 디스크는 243GB였다. 디스크가 모자라면 N을 줄이거나 저장 위치(ADR 0025 미정)를 먼저 정해야 한다.
6. **브라우저 밖 경보를 어디로 보낼지.** 기본값은 이번 단계에서 정하지 않는 것이다(결정 8). `OnFailure=`는 journal에만 남는다. 정하면 `collector-ops`가 그 경보처로 보내는 유닛을 둔다.

검증을 약하게 하는 변경(검증 단계 삭제, 시간 제한 증가, `paths` 축소)은 없다.
