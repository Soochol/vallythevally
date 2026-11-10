# 개발 PC 환경의 함정

이 PC(로컬 개발·운영)에서 실제로 겪은 문제와 대처 방법이다. 자세한 진단은 이슈 #23에 있다.

## 드문 경우: AhnLab ASTx가 연결을 끊는다
- 이 PC에서 금융 사이트가 ASTx 세션을 켜면 생길 수 있다(2026-11-09 이후 다시 생기지 않음). 자세한 진단은 이슈 #23에 있다.
- **증상**: 키움 조회가 15초 시간 초과로 끝나거나, 로컬 주소(127.0.0.1) 연결도 가끔 끊긴다. 같은 요청을 `curl`로 보내면 빨리 성공한다.
- **확인과 대처**: `journalctl -t astxdaemon --since today | grep -E 'showTray|hideTray'`의 마지막이 `showTray`면 세션이 켜져 있다. 금융 사이트 탭이나 브라우저를 닫는다.
- **하지 말 것**: ASTx를 지우거나 설정을 바꾸지 않는다. 금융 사이트 이용에 영향을 준다.

## 키움 주소 두 줄이 없으면 서버가 켜지지 않는다
- 2026-11-09부터 키움 주소에 기본값이 없다(사용자 결정). 시험 서버가 기본 주소로 실제 키움에 붙는 사고를 막으려는 것이다.
- **증상**: 서버가 `VALLY_KIWOOM_BASE_URL과 VALLY_KIWOOM_WS_URL을 .env에 둘 다 적어야 합니다`를 남기고 끝난다.
- **대처**: 메인 체크아웃의 `.env`(ADR 0004)에 두 줄을 적는다. 비밀값이 아니다.
  ```
  VALLY_KIWOOM_BASE_URL=https://api.kiwoom.com
  VALLY_KIWOOM_WS_URL=wss://api.kiwoom.com:10000/api/dostk/websocket
  ```
- 시험은 두 주소를 모두 가짜 키움(루프백)으로 준다. 하나만 실제거나, 실제도 루프백도 아닌 호스트면 시작하지 않는다.

## 공인 IP가 바뀌면 키움이 8050을 준다
- 키움 앱키는 등록된 공인 IP에서만 토큰을 준다. 공인 IP는 PC가 아니라 **연결한 공유기(Wi-Fi)**의 주소다. 그래서 다른 장소의 Wi-Fi에 연결하면 바뀐다. 예: 2026-11-09에 다른 장소의 공유기에 연결하자 `221.147.204.12`(등록됨)에서 `221.147.204.61`로 바뀌었다. 집 회선의 유동 IP도 바뀔 수 있다.
- **증상**: 토큰 발급이 `[8050]`(지정단말기)으로 거절된다. 서버는 즉시 멈추고(ADR 0004), 상태 줄에 IP 미등록일 수 있다고 안내한다.
- **대처**: `curl -s https://api.ipify.org`로 지금 공인 IP를 확인한다. 등록한 장소로 돌아가거나, 이곳 주소를 키움 REST API 포털에 추가로 등록한다(앱키당 최대 10개). 쓰는 장소마다 등록해 두고, 이전 IP는 지우지 않는다. 그다음 서버를 다시 켠다.
- **근본 해법**: 고정 IP가 있는 서버로 옮긴다(#9).

## 일반 터미널에서는 e2e의 Chromium이 샌드박스를 못 띄운다
- **증상**: `playwright test`가 모든 테스트에서 `Chromium sandboxing failed!`, `No usable sandbox!`로 실패한다.
- **원인(2026-11-09 확인)**
  - 이 PC는 `kernel.apparmor_restrict_unprivileged_userns = 1`이다. AppArmor 프로필이 `userns`를 허락하지 않은 프로그램은 사용자 이름공간을 만들지 못하고, Chromium 샌드박스는 사용자 이름공간이 있어야 뜬다.
  - e2e는 `chromiumSandbox: true`로 Chromium을 띄운다(PR #32 R2). Orca 안에서는 통과한다. Orca가 `orca-ide (unconfined)` 프로필 아래에서 돌고(`cat /proc/self/attr/current`), 그 자식인 Chromium이 이 프로필을 물려받기 때문이다. 일반 터미널에는 이런 프로필이 없다.
- **대처**: CI와 같은 프로필을 사용자가 직접 깐다. `web/`에서 `./scripts/allow-chromium-sandbox.sh`(sudo를 묻는다). 설치된 Playwright headless shell 하나에만 `userns`를 허락한다. Playwright를 올려 브라우저 경로가 바뀌면 다시 실행한다.
  - 이 프로필을 깔아도 `check.sh`는 일반 터미널에서 기본 설정으로 돌지 않는다. 시험을 감싸는 `scripts/offline.sh`가 이름공간을 만들지 못한다. 아래 절의 명시적 해제는 이 네트워크 차단만 해제하며, Chromium 샌드박스 설정은 별도로 필요하다.
- **하지 말 것**: 샌드박스를 끄거나(`chromiumSandbox: false`) `sysctl`로 PC 전체의 제한을 풀지 않는다.

## push 전에 로컬 검사가 돈다
- 이 PC의 `.git/hooks/pre-push`가 `git push` 때 `scripts/check.sh`를 돌린다. CI의 lint, test, build, wasm, e2e와 같은 명령이다. 하나라도 실패하면 push가 막힌다. 새 worktree에서는 빌드부터 해서 약 1분 30초가 걸린다.
- 커밋하지 않은 변경이 있으면 push를 막는다. 검사는 작업 트리를 보기 때문이다.
- **GitHub Actions CI는 꺼져 있다**(2026-11-09 사용자 결정, `gh workflow disable CI`). 브랜치 보호의 필수 검사도 뺐다. 되돌릴 때는 `gh workflow enable CI`, 필수 검사 목록은 lint, test, build, e2e였다.
- 병합 판정은 로컬 검사로 한다. 코디네이터가 병합 직전에 PR 머리 커밋의 깨끗한 worktree에서 `scripts/check.sh`를 다시 돌리고, 통과 결과를 PR 댓글에 남긴 뒤 병합한다.
- 시험은 외부 네트워크 없이 돈다(아래 절).
- 이 hook은 저장소에 올라가지 않는다. 끄려면 `.git/hooks/pre-push`를 지운다.

## 시험은 외부 네트워크 없이 돈다
- `check.sh`는 `cargo test`, vitest, wasm 참조값 검사(`wasm-smoke.mjs`), Playwright e2e를 `scripts/offline.sh`로 감싼다. 기본 설정에서는 루프백(127.0.0.1, 가짜 키움과 서버)만 켠 네트워크 이름공간에서 돌린다. sudo는 필요 없다. 다른 명령도 `scripts/offline.sh <명령>`으로 같은 곳에서 돌릴 수 있다.
- **이유**: 2026-11-09 #4 브랜치의 로컬 시험이 기본값 때문에 실제 키움 WebSocket에 가짜 토큰으로 LOGIN했다(이슈 #48).
- **방식(2026-11-09 확인)**: `unshare --map-root-user --net`으로 이름공간을 만들고 `lo`를 켠 뒤, 사용자 이름공간을 하나 더 만들어 원래 uid로 돌아간다. Chromium은 root(이름공간 안의 uid 0)로는 샌드박스를 켜고 뜨기를 거부한다(`Running as root without --no-sandbox is not supported`).
- **준비 실패도 실패다**: `ip`가 없거나 `ip link set lo up`이 실패하면 자식 명령을 실행하지 않고 해당 종료 코드를 돌려준다. `check.sh`의 `scripts/test-offline.sh`가 실제 이름공간에서 두 반례를 확인한다. 이름공간을 만들 수 없는 환경에서는 이 준비 단계 시험만 건너뛰며, 뒤의 시험은 아래 해제 규칙을 그대로 따른다.
- **잡히는 것**: 바깥 주소로 나가는 연결은 바로 실패한다. 이름은 `Temporary failure in name resolution`, IP 주소는 `Network is unreachable`, 브라우저는 `net::ERR_INTERNET_DISCONNECTED`.
- **막지 못하는 것**
  - `check.sh` 밖에서 직접 돌린 `cargo test`나 `playwright test`. 직접 돌릴 때도 `scripts/offline.sh`로 감싼다.
  - 감싸지 않은 단계: `cargo clippy`, `cargo build`(빌드 스크립트와 proc macro 포함), `pnpm install`, `pnpm build`, `build-wasm.sh`. 의존성을 받아야 해서 일부러 밖에 둔다.
  - 파일 경로가 있는 Unix 소켓. 네트워크 이름공간이 나누지 않는다. D-Bus 세션 버스를 통해 `systemd-run --user`로 실행한 명령과 Docker 소켓을 통해 `--network host`로 실행한 컨테이너는 호스트 네트워크를 쓸 수 있다. PR #51 리뷰에서 두 경로 모두 호스트의 임시 루프백 서버에 접속했다(2026-11-09). 외부 사이트나 실제 키움으로 우회 접속하지는 않았다.
  - 이 장치는 시험이 실수로 실제 주소에 직접 접속하는 일을 막는다. 일부러 호스트 데몬을 호출해 우회하는 코드는 범위 밖으로 받아들인다(2026-11-09 사용자 결정). PR #46의 키움 주소 필수화는 주소가 빠진 서버를 시작 단계에서 막는 별도 장치다.
- **일반 터미널에서는 이름공간을 만들지 못한다**: `kernel.apparmor_restrict_unprivileged_userns = 1`이라 일반 터미널(`unconfined`)에서 만든 사용자 이름공간은 `unprivileged_userns` 프로필로 옮겨져 capability를 모두 잃는다. 그래서 `unshare`가 `write failed /proc/self/uid_map: Operation not permitted`로 실패하고, `offline.sh`는 기본 설정에서 안내를 찍고 멈춘다(2026-11-09, Orca 안에서 `systemd-run --user`로 일반 터미널과 같은 `unconfined` 프로필의 프로세스를 띄워 확인했다. 실제 터미널 창에서는 돌려 보지 않았다). 기본 설정으로 검사하려면 Orca 안에서 push한다.
- **명시적 해제**: 이름공간을 만들 수 없는 환경에서 네트워크 차단 없이 같은 시험을 돌리려면 `VALLY_CHECK_ALLOW_NETWORK=1 scripts/check.sh`를 실행한다. push에도 적용하려면 `VALLY_CHECK_ALLOW_NETWORK=1 git push`를 쓴다. 이 값이 정확히 `1`일 때만 허용한다. 각 시험 전에 표준 오류로 큰 경고를 출력한다. 외부 TCP 연결과 DNS 조회, 실제 키움 접속이 막히지 않아 시험의 잘못된 주소가 실제 요청을 보낼 수 있다. 시험이 가짜 키움과 로컬 주소만 사용하는지 먼저 확인한다.
  - 이름공간을 만들 수 있으면 이 변수가 있어도 네트워크를 차단한다. 루프백 준비 실패나 자식 명령 실패를 네트워크 허용으로 재시도하지 않는다. 이 해제는 Chromium 샌드박스를 끄지 않는다.
  - **해제 경로 확인(2026-11-09)**: `systemd-run --user`의 `unconfined` 환경에서 변수 없이는 자식을 실행하지 않고 종료 1이었다. 값이 `1`이면 경고 후 같은 `check.sh`가 Rust 253개, Vitest 164개, wasm 참조값 7개를 통과했다. e2e 21개는 위의 별도 Chromium 샌드박스 제한(`No usable sandbox!`)으로 실패했다. 실제 일반 터미널 창에서 실행한 결과는 아니다.
- **안 되는 대안**: `bwrap --unshare-net`은 두 환경 모두에서 `lo`를 켜고 네트워크를 막는다. 하지만 자식 프로세스가 `unpriv_bwrap` 프로필에서 capability를 잃어 Chromium이 `No usable sandbox!`로 뜨지 않는다.
- **하지 말 것**: `offline.sh`를 빼거나 `sysctl`로 PC 전체의 제한을 풀지 않는다. 해제가 필요하면 위의 명시적 해제를 사용한다.
