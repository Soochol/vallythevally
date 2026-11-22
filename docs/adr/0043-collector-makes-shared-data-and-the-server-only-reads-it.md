# 공용 자료는 수집 데몬이 만들고 서버는 읽기만 하며, 키는 일 단위 배정표로 나누고 키별 TR 사용량을 남긴다

[ADR 0038](0038-user-kiwoom-keys-stay-in-the-browser-and-collection-runs-on-one-server.md)은 순위, 시장 개요, 스크리너, 히트맵 같은 공용 자료를 운영 서버가 운영자 키로 만들어 모두에게 주기로 했다. 지금은 `vally-server`가 요청마다 키움을 불러 사용자 수와 키움 호출 수가 함께 는다. 이 ADR은 공용 자료를 [감독 데몬](0026-collector-supervisor-collects-common-and-preferred-stocks.md)이 정해진 주기에 한 번 만들게 하고 서버는 읽기만 하게 하는 구조를 정한다. 플랜은 [`docs/plans/collector-shared-data.md`](../plans/collector-shared-data.md)(확정 1·5·6·7, 결정 A1~A5·B1~B7)이고, 이 ADR은 그 가운데 키·배정·실행·사용량의 바닥을 기록한다. 자료별 일(스냅샷, 순위, 시장 개요, 분봉)은 뒤 작업이 더하고 그때 이 ADR을 따른다.

## 결정

- **만드는 곳과 넘기는 길**: 공용 자료는 감독 데몬이 수집 전용 키로 만들고, 서버는 만들지 않는다. 넘기는 길은 파일이다. 데몬이 공용 자료 폴더(`supervise --shared`, 기본 `<--data>/shared`)에 자료마다 파일을 쓰고 서버는 그 폴더를 읽는다(파일 형식과 쓰기 함수는 `crates/server/src/shared_data/`, 문서는 [`docs/collector-shared-data.md`](../collector-shared-data.md)). 요청 경로에 소켓 왕복이 없고, 장중에 다시 시작할 수 없는 데몬이 서버의 요청을 받는 길이 생기지 않는다. 수집기는 이미 `server`에 의존하므로 새 크레이트도 의존 방향 변경도 없다.
- **키 역할과 증권사**: 키 목록은 형식 버전 2에서 키마다 `role`(`collect`·`spare`·`rest`)과 `broker`(`kiwoom`·`kis`)를 둔다. 버전 1은 그대로 읽는다(`spare: true`는 `spare`, 나머지는 `collect`, 증권사는 `kiwoom`). `rest`는 실시간 세션이 없는 REST 키로 공용 자료만 맡는다. 예비 키에는 맡기지 않는다. 멈춘 수집 키의 몫을 받아야 하기 때문이다. 한투 키는 `rest`만 될 수 있다. 한투 키도 키움과 같은 비밀값 파일 변수와 검사(권한 600, 앱키 해시 일치)를 쓰고, 서버의 한투 키(`VALLY_KIS_APP_KEY`)와 같으면 거부한다([ADR 0039](0039-kis-key-and-token-are-vally-only.md)).
- **키 배정표**: 일 단위 배정은 별도 설정 파일(`supervise --shared-config`, 기본 `~/.config/vally/collector-shared.json`, 형식 버전 1, 모르는 칸은 오류)에 둔다. 일 이름은 닫힌 열거형이다. 일마다 키 목록(순서가 우선순위), 주기, 일이 정하는 선택값을 두고 키마다 선택 항목 `total_per_second`를 둔다. 배정된 키는 `rest` 역할이어야 하고 그 일이 받는 증권사여야 한다. 같은 일에 키를 여럿 적으면 일이 나눌 단위를 키 수로 나눠 동시에 부른다. 데몬은 매일 07:35 계획 때 다시 읽는다. 읽지 못하거나 검사에 걸리면 전날(직전에 읽은) 배정을 쓰고 경보한다. 파일이 없으면 공용 자료 일을 돌리지 않는다. 장중에는 읽지 않으므로 배정을 바꾸는 데 재시작이 필요 없고 바뀐 배정은 다음 관측일 자식부터 쓰인다.
- **공용 자료 자식**: 데몬이 배정표에 든 `rest` 키마다 `collector shared --child` 하나를 띄운다. 토큰은 데몬이 발급해 stdin으로 준다(키움은 `KeyTokens`, 한투는 `KisAuth`와 키별 토큰 파일). 자식은 키·시크릿을 모르고 발급하지 않는다. 재시작 간격·한도·하트비트는 `collect` 자식과 같고 자식에 `PR_SET_PDEATHSIG`를 건다. 자식이 한도를 넘거나 키가 막히면 그 키의 일을 배정표에서 같은 일의 남은 키들에 다시 나눠 주고 사건 기록(`plan/<날짜>.events.jsonl`)에 남긴다. 줄 JSON 형식 버전은 2로 올린다(ADR 0026의 버전 규칙).
- **일 실행기**: 일은 관측일 안의 시간대와 주기를 갖는다. 한 번이 주기를 넘으면 겹쳐 띄우지 않고 끝나자마자 다음을 시작하며 넘친 횟수를 센다. 모든 호출은 `Priority::Background`다(데몬 쪽 키에는 화면이 없다). 일 목록은 `crates/collector/src/shared/mod.rs` 한 곳이다.
- **키별 TR 사용량**: 공용 자료 자식과 데몬의 REST가 1분마다 키·TR별 `sent`·`rate_limited`·`resent`·`max_wait_ms`·`max_per_second`와 키 전체 `max_per_second`(최근 1초 전송 합계의 최댓값)를 `<--data>/usage/<YYYYMMDD>.jsonl`에 쓰고 상태 API의 키 항목에도 지난 1분 값을 싣는다. 키 전체 최댓값은 `KiwoomRest`의 1분 카운터에 합계 창과 상관없이 센다. `total_per_second`를 켠 키는 그 키의 `KiwoomRest` 합계 창을 그 값으로 켠다(생성 인수).
- **확인 전 보수 배정**: [ADR 0035](0035-kiwoom-queue-counts-each-tr-per-second.md)의 미확인 사항("초당 5회"가 키 하나의 TR 합계인지)은 운영 중에 확인한다. 스냅샷과 순위처럼 TR이 다른 일을 `total_per_second` 없이 한 `rest` 키에 함께 배정한 관측일 하루의 사용량 줄을 읽는다. 키 전체 `max_per_second`가 5를 넘은 분에 TR마다 `max_per_second`가 5 이하인데 `rate_limited`가 나면 합계 한도다. 확인하기 전에는 `rest` 키마다 `total_per_second: 5`를 켜고 일을 키마다 하나씩 두는 보수적인 배정으로 돈다. 결과는 ADR 0035에 개정 줄로 적는다.

## Considered Options

- **서버가 데몬의 소켓 API로 묻기**: 요청마다 왕복이 생기고, 장중에 다시 시작할 수 없는 데몬이 서버의 요청을 받게 된다. 데몬이 쓰기만 하는 길이 데몬을 덜 흔든다.
- **새 크레이트로 형식을 나누기**: `Cargo.lock`이 바뀌고 이득이 없다. 수집기는 이미 `server`에 의존한다.
- **한도 확인용 별도 명령**: 데몬이 쥔 키 잠금과 부딪친다. 실제 일 두 개를 한 키에 두면 운영 경로 그대로 잴 수 있다.
- **키마다 하나의 일만 두기**: 한도 확인 결과가 어느 쪽이어도 코드는 같고 설정만 달라지게 하려고 배정표로 뒀다.
- **`rest` 키도 `collect` 자식에서 REST를 부르게 하기**: 실시간 세션 하나의 panic이나 지연이 공용 자료와 수집을 함께 멈춘다. 자식을 나눠 서로를 지킨다.

## Consequences

- 서버가 읽는 쪽(`VALLY_SHARED_DATA_DIR`)과 자료별 일은 뒤 작업이다. 이 ADR만으로는 서버 동작이 바뀌지 않는다.
- 배포하면 줄 JSON 형식이 바뀌므로 데몬은 마감 정리 뒤에만 새 판으로 뜨고, 배정표는 다음 관측일부터 쓰인다. 배정표가 없으면 데몬은 지금과 같이 돈다.
- 배정표에 든 `rest` 키는 키 잠금과 토큰 파일을 데몬이 쥔다(ADR 0004). 같은 앱키를 다른 프로세스가 쓰면 안 된다.
- 한도 확인 전에는 TR이 다른 일을 한 키에 두는 이점(처리량)을 쓰지 못한다.
- 사용량 줄은 하루 한 파일에 쌓인다. 1분마다 키·TR당 한 줄이라 양이 작다.
