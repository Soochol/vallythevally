# 재무자료는 수집기의 별도 프로세스가 모으고 서버는 읽기만 한다

재무자료(OpenDART)는 사용자 키와 상관없는 공용 자료다. 지금은 `vally-server`가 모으지만, 서버 PC는 공용 서버이고 사용자 PC는 개인 엔진이 되므로([ADR 0045](0045-desktop-app-runs-a-personal-engine-and-the-server-keeps-login-and-shared-data.md)) 수집은 서버 PC의 수집기가 맡고 서버와 개인 엔진은 저장된 재무자료를 읽기만 한다. [ADR 0043](0043-collector-makes-shared-data-and-the-server-only-reads-it.md)의 "공용 자료는 수집기가 만들고 서버는 읽는다"를 재무자료에 적용한 결정이다. 조회와 업데이트를 나누고 매일 07:00에 확인하는 규칙은 [ADR 0015](0015-financial-charts-read-collected-data.md)를 따른다. 플랜은 [`docs/plans/financials-collector.md`](../plans/financials-collector.md)이고, 이 ADR은 그 결정 D1~D9를 기록한다.

## 결정

- **합치기 도구는 만들지 않는다(D1).** 개발 PC와 서버 PC의 `financials.db`를 회사·보고서 키로 맞대어 보니 개발 PC에만 있는 회사 재무 기록이 0건이었다. 개발 PC에만 있는 것은 끝난 세대의 응답 일지뿐이고 서버가 읽거나 다시 쓰지 않는다.
- **수집 코드는 `crates/server/src/financials/`에 두고 돌리는 곳만 옮긴다(D2).** 수집기가 이미 `server`에 의존하므로 코드를 옮기면 자리만 바뀐다. 조회 계산은 서버가 계속 쓴다.
- **수집은 수집기 바이너리의 별도 프로세스 `collector financials run`이 한다(D3).** 유닛 `vally-financials.service`가 `PartOf=vally-collector.service`로 감독 데몬과 함께 멈추고 다시 뜬다. 같은 바이너리와 `PartOf`를 쓰므로 배포는 데몬과 같은 규칙이다. `collector-install`이 수집 시간 안에는 `.next`에 두고, 마감 뒤 `collector-restart`가 데몬을 다시 띄우면 재무 프로세스도 새 판으로 뜬다. 데몬 코드와 줄 JSON 프로토콜은 바꾸지 않는다.
- **쓰는 쪽은 하나다(D4).** 업데이트를 띄우는 쪽은 DB 옆 `<DB 경로>.writer.lock`을 배타로 쥔다. `collector financials run`은 시작할 때 쥐고 못 쥐면 종료 코드 2로 끝난다. 서버는 처음 업데이트를 띄울 때 쥐고 프로세스가 끝날 때까지 놓지 않으며, 못 쥐면 그 업데이트를 띄우지 않는다. 서버가 시작할 때 쥐지 않는 것은 전환 중 자동 확인만 끈 서버가 잠금을 쥐어 수집기가 뜨지 못하는 일을 막으려는 것이다.
- **저장소는 WAL로 바꾼다(D5).** 쓰는 쪽이 열 때 `journal_mode=WAL`을 건다. 서버는 읽기 전용으로 열고 쓰기를 기다리지 않는다. 회사 기록 하나가 최대 10.7MB라, 롤백 저널에서는 차트 조회가 그만큼의 쓰기를 기다린다.
- **대상 종목은 데몬이 쓰는 종목 목록 파일에서 읽는다(D6).** 재무 프로세스는 키움 키를 갖지 않는다. `<--data>/universe/<YYYYMMDD>.json`의 가장 최근 파일을 쓰고, 하나도 없으면 OpenDART를 부르지 않고 상태에 종목 목록 없음을 보인다. 스팩은 서버와 같이 보통주로 본다.
- **OpenDART 키는 파일에 둔다(D7).** `~/.config/vally/opendart-key`, 권한 600이다. 권한이 600이 아니거나 비어 있으면 시작하지 않는다. 키 값은 출력에 나오지 않는다.
- **운영자는 CLI와 텔레그램으로 본다(D8).** `collector financials status|start|pause|resume`이 재무 프로세스의 unix socket(`<state>/financials.sock`, 권한 600)으로 묻는다. 인증 중단, 호출 한도 중단, 저장 실패로 바뀌면 데몬과 같은 텔레그램 설정으로 한 번 알린다. 운영자 리스너의 시스템 설정 상태판에 싣는 일은 후속이다.
- **서버의 조회는 저장 자료로만 상태를 정한다(D9).** 수집 중인지는 다른 프로세스의 메모리라 서버가 모른다. `collecting` 대신 저장 자료의 `ready`, `stale`, `partial_failure`, `not_collected`를 쓰고, DB 파일이 없으면 `not_configured`다.

## Considered Options

- **감독 데몬의 자식으로 돌리기**: 데몬 상태 API와 경보를 그대로 쓸 수 있다. 그러나 OpenDART는 키움 키, 토큰, 관측일 일정이 필요 없고 휴장일과 주말에도 07:00에 확인하며 과거 단계는 며칠씩 이어져, 관측일마다 띄우고 거두는 자식 모델과 맞지 않는다. 관측일 밖에도 사는 자식 종류를 데몬에 새로 넣어야 해 데몬 코드가 크게 바뀐다. 재무 수집의 panic이나 큰 쓰기가 실시간 수집을 멈출 수도 있다.
- **수집 코드를 `collector` 크레이트로 옮기기**: 약 3,000줄과 시험 약 4,000줄이 자리만 바뀐다. 수집기가 이미 `server`에 의존하므로 얻는 것이 없다.
- **개발 PC 자료를 합치는 도구 만들기**: 합칠 자료가 없어 시험과 절차만 늘고 자료는 한 건도 늘지 않는다.
- **롤백 저널 유지**: 수집과 조회가 두 프로세스로 나뉘면 차트 조회가 수집의 큰 쓰기를 기다린다.

## Consequences

- 서버는 "지금 이 회사를 모으는 중"을 모른다. 차트는 저장 자료의 `stale`로 보인다.
- 재무 코드의 수정은 데몬과 같이 마감 뒤에 켜진다.
- 서버에서 수집과 화면을 걷는 일은 뒤 작업(`fin-server-read`)이 한다. 그 전까지 서버의 업데이트 버튼은 남지만 잠금 때문에 업데이트가 뜨지 않는다.
- 전환 중 몇십 분은 재무를 모으지 않는다. 전환 절차는 [서버 운영 문서](../server-operations.md)의 "재무 수집 전환"이다.
- 재무 저장 형식의 쓰기 양은 이 ADR이 다루지 않는다. 한 세대의 일지가 쌓이면 파일은 다시 커진다.
