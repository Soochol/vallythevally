# 원격 접속은 `tailscale serve`가 받고, 서버는 설정한 tailnet 이름만 자기 이름으로 받는다

공개 리스너는 [ADR 0040](0040-the-public-listener-serves-browser-logins-and-shared-data-apart-from-the-operator-listener.md)이 정한다. 이 ADR의 규칙(루프백 바인드, `tailscale serve`, `VALLY_TAILNET_HOSTS`, Host·Origin 검사)은 운영자 리스너에 그대로 적용된다.

실서버를 Tailscale 망의 서버 PC로 옮기고 같은 망의 기기(개발 PC, 폰) 브라우저로 쓰려 한다. 계획은 [서버 PC 이전](../plans/server-pc.md)이다. 서버는 루프백만 받고, `write_guard.rs`의 Host·Origin 검사는 루프백 형태가 아닌 Host를 거절한다. 이 검사는 DNS rebinding으로 남의 웹 페이지가 로컬 서버에 쓰는 것을 막는 장치이고, 쓰기 가드와 계좌번호 조회(`GET /api/trading/account-number`), 로그인 완료(`GET /auth/complete`)에 걸려 있다. 그래서 `tailscale serve`를 거친 요청은 지금 모두 거절된다.

## 정한 것

- **서버는 루프백만 받는다.** `BindAddr`의 규칙(127.0.0.0/8, `::1`)은 바뀌지 않는다. 원격 접속은 서버 PC의 `tailscale serve`가 `https://<서버>.<tailnet>.ts.net`으로 받아 `http://127.0.0.1:8080`으로 넘긴다. 공인·LAN·`100.x` 주소의 8080은 연결 자체가 안 된다.
- **새 설정 `VALLY_TAILNET_HOSTS`.** 쉼표로 구분한 MagicDNS 전체 이름이다. 앞뒤 공백을 지우고 소문자로 맞춘다. 비었거나 없으면 빈 목록이고 동작은 지금과 같다.
  - 받는 값은 `<기기>.<tailnet>.ts.net`이다. 점으로 나뉜 라벨이 영문 소문자·숫자·하이픈이고(하이픈으로 시작하거나 끝나지 않는다), `.ts.net` 앞에 라벨이 둘 이상이다.
  - 다음은 설정 오류로 서버가 시작하지 않는다: `.ts.net`으로 끝나지 않는 이름, 포트·스킴·경로가 붙은 값, 와일드카드, IP, 빈 항목, `ts.net`이나 `x.ts.net`처럼 라벨이 모자란 이름. 잘못 적은 값이 조용히 무시돼 접속이 안 되는 것보다 시작 때 멈추는 쪽이 낫다.
- **Host 검사.** Host가 루프백 형태이거나 포트 없이 설정한 이름과 정확히 같으면(대소문자 무시) 받는다. 설정하지 않은 `*.ts.net`, 공인·LAN IP, `100.x` IP, 포트가 붙은 이름은 거절한다. 포트 없는 이름만 받는 것은 `tailscale serve`가 https 기본 포트(443)로 받아 Host를 원래 이름 그대로 넘긴다는 가정이다. 이 가정은 운영 단계에서 확인한다.
- **Origin 검사.** Origin이 없으면 지금처럼 받는다. 있으면 하나여야 한다. Host가 루프백이면 `http://<Host>`, Host가 설정한 이름이면 정확히 `https://<그 이름>`이다. `http://<이름>`, `https://<이름>:443`, 다른 설정 이름은 거절한다. 브라우저는 https 페이지의 Origin에 기본 포트를 붙이지 않는다.
- **배선.** 설정은 `Config`에서 `SystemState`로 들어가고 `write_guard`가 거기서 읽는다. 바인드 주소를 이미 `SystemState`가 들고 있어서 Host 검사에 필요한 값이 한곳에 모인다.
- **범위 밖.** 가드 밖 `POST` 네 개(`/api/screener/update`, `/api/screener/update/cancel`, `/api/screener/run`, `/api/rankings`)에는 가드를 걸지 않는다. 이 위험은 `127.0.0.1:8080`에서도 같아 tailnet 공개가 넓히지 않는다. 계정 로그인의 돌아갈 주소는 `http://127.0.0.1:<포트>` 고정이라 원격 브라우저의 로그인은 이번에 되지 않는다.

## Considered Options

- **`*.ts.net` 전체를 받기**: 남의 tailnet 이름도 `.ts.net`이라 접미사만으로는 내 tailnet을 구분하지 못한다. 접미사로 받으면 이 서버가 자기 것이 아닌 이름의 Host까지 자기 요청으로 받게 되고, Host 검사가 막으려는 "다른 이름으로 온 요청"이 `.ts.net` 전체로 넓게 열린다. 받는 것은 사용자가 적은 정확한 이름뿐이다.
- **서버가 `100.x`에 직접 바인드하기**: 페이지가 `http://100.x.x.x:8080`이 되어 보안 문맥이 아니다. 화면이 쓰는 `crypto.randomUUID`(주문 명령 ID, 관심종목, 레이아웃, 그리기 등 15곳 넘게)와 `navigator.clipboard`가 없어 주문·관심종목 추가·레이아웃 저장이 예외로 멈춘다. 바인드 규칙도 루프백 전용에서 여러 주소로 넓혀야 해서 공인·LAN 주소가 구조적으로 막혀 있다는 성질이 사라진다.
- **Host 검사를 없애고 Origin만 보기**: Origin이 없는 요청이 통과하고, DNS rebinding 방어가 사라진다.
- **Tailscale 사용자 신원 헤더로 사람을 가리기**: 접속 범위가 이미 내 tailnet의 기기라 이번에 필요하지 않다.

## Consequences

- 이름을 설정하지 않은 서버는 지금과 같다. 설정하면 그 이름의 Host가 쓰기와 계좌번호 조회, 로그인 완료를 쓸 수 있다.
- `tailscale serve`가 Host를 원래 이름 그대로 넘기지 않는 구성이면 규칙을 고쳐야 한다. 운영 단계에서 확인한다.
- 설정한 이름은 tailnet 안의 어느 기기에서든 서버의 쓰기에 닿는다. 접속 범위를 좁히는 것은 Tailscale의 접근 규칙(ACL) 몫이다.
