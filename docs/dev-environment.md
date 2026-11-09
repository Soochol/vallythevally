# 개발 PC 환경의 함정

이 PC(로컬 개발·운영)에서 실제로 겪은 문제와 대처 방법이다. 자세한 진단은 이슈 #23에 있다.

## 드문 경우: AhnLab ASTx가 연결을 끊는다
- 이 PC에서 금융 사이트가 ASTx 세션을 켜면 생길 수 있다(2026-11-09 이후 다시 생기지 않음). 자세한 진단은 이슈 #23에 있다.
- **증상**: 키움 조회가 15초 시간 초과로 끝나거나, 로컬 주소(127.0.0.1) 연결도 가끔 끊긴다. 같은 요청을 `curl`로 보내면 빨리 성공한다.
- **확인과 대처**: `journalctl -t astxdaemon --since today | grep -E 'showTray|hideTray'`의 마지막이 `showTray`면 세션이 켜져 있다. 금융 사이트 탭이나 브라우저를 닫는다.
- **하지 말 것**: ASTx를 지우거나 설정을 바꾸지 않는다. 금융 사이트 이용에 영향을 준다.

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
- **하지 말 것**: 샌드박스를 끄거나(`chromiumSandbox: false`) `sysctl`로 PC 전체의 제한을 풀지 않는다.

## push 전에 로컬 검사가 돈다
- 이 PC의 `.git/hooks/pre-push`가 `git push` 때 `scripts/check.sh`를 돌린다. CI의 lint, test, build, wasm, e2e와 같은 명령이다. 하나라도 실패하면 push가 막힌다. 새 worktree에서는 빌드부터 해서 약 1분 30초가 걸린다.
- 커밋하지 않은 변경이 있으면 push를 막는다. 검사는 작업 트리를 보기 때문이다.
- **GitHub Actions CI는 꺼져 있다**(2026-11-09 사용자 결정, `gh workflow disable CI`). 브랜치 보호의 필수 검사도 뺐다. 되돌릴 때는 `gh workflow enable CI`, 필수 검사 목록은 lint, test, build, e2e였다.
- 병합 판정은 로컬 검사로 한다. 코디네이터가 병합 직전에 PR 머리 커밋의 깨끗한 worktree에서 `scripts/check.sh`를 다시 돌리고, 통과 결과를 PR 댓글에 남긴 뒤 병합한다.
- CI에만 있던 외부 네트워크 차단(`unshare --net`)과 Chromium 샌드박스 프로필이 로컬에는 없다. 시험 서버의 키움 REST·WS 주소가 모두 가짜인지 확인한다. 로컬에서 네트워크를 막는 일은 #48이다.
- 이 hook은 저장소에 올라가지 않는다. 끄려면 `.git/hooks/pre-push`를 지운다.
