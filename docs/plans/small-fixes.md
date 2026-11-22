# 미뤄 둔 작은 수정 셋 플랜: 계정 삭제 시험, verify-vally doctor, 차단 뒤 코드 교환

작성일 2026-11-23. 승인 시점의 기록이며 구현 중 바뀐 것은 반영하지 않는다.

코드 사실의 기준 시점은 `origin/main` `d12a6158`(#788)이다.

## 사용자가 풀려는 문제

사용자는 "미뤄둔것 진행 가능?"이라고 물었다. 오케스트레이터가 기다림 목록의 #6·#7·#18을 작업 하나로 묶자고 제안했고, 사용자가 "응"으로 승인했다.

- #6: `crates/server/tests/account_login.rs`의 `when_the_state_file_cannot_be_removed_after_deletion_memory_and_file_still_agree`가 가끔 실패한다는 기록. 계정 삭제 직후 동기화 작업이 지워진 토큰으로 401을 받아 로그아웃하는 경쟁이 원인으로 적혀 있다.
- #7: verify-vally 계정 모드의 `vv.py doctor`가 거짓으로 실패한다. 셸 env 값에 `googleapis.com`이나 `kiwoom.com`이 들어 있으면 `ok:false`가 된다(예: `PIP_EXTRA_INDEX_URL=https://storage.googleapis.com/…`).
- #18: 차단 전에 발급된 일회용 코드(수명 60초)를 차단 뒤에 교환하면 `/v1/auth/token`이 200을 주고 `connector_tokens` 행을 만든다. 그 토큰은 모든 요청에서 401이라 권한은 없지만, 차단된 계정에 토큰 행이 생긴다.

## 코드에서 확인한 것

### #6은 이미 풀렸다

- #6은 작업 `acct-login-harden`의 chute 반송 1(PR #499, 기준 `3ba4dcd2`, 2026-11-18 02시대)에서 나왔다. 그때 시험은 상태 디렉터리 권한을 0o700으로 되돌린 **뒤에** 상태를 읽었다. 그래서 동기화 작업의 `expire`가 그 사이에 돌면 상태 파일 지우기가 성공해 `signed_out`이 됐다.
- 그 뒤 #530(`f3c8ac74`, 2026-11-18 12:38)이 상태 확인과 상태 파일 확인을 디렉터리가 0o500인 동안 하도록 옮겼다. `ca4ed61d`는 권한 복구를 Drop 가드로 옮겼다.
- 지금 코드에서는 경쟁이 일어나지 않는다.
  - `expire`(`crates/server/src/account/sync.rs`)는 `linked.file.remove()`가 성공해야 메모리를 로그아웃으로 바꾼다.
  - 시험의 상태 확인은 모두 디렉터리가 0o500인 동안 끝난다. 그동안 지우기는 늘 실패한다.
  - 권한을 되돌린 뒤에 동기화 작업이 로그아웃하면 상태 파일도 사라진다. 시험이 기대하는 재시작 뒤 `signed_out`, 상태 파일 없음과 같다.
- chute 기록도 같다. `~/.local/state/chute/repos/Soochol__vallythevally/batches/`에서 이 시험이 실패한 로그는 2026-11-18 04:45가 마지막이다(`b20261118-024702`, `-032428`, `-044405`). #530 뒤로는 batch 82개, 93번 실행이 모두 `ok`다.

### #7의 원인

`.claude/skills/verify-vally/scripts/vv.py`의 `sandbox_env()`는 셸 env를 거의 다 넘긴다. 빼는 것은 `VALLY_*`, `OPENDART_API_KEY`, `*_proxy`뿐이다. `account_problems()`는 `vally-account`·`vally-fake-idp` 프로세스의 env 값 전체에서 실제 IdP 호스트 문자열을 찾는다. 그래서 상관없는 셸 변수 하나로 doctor가 실패한다.

### #18의 원인

`exchange_token`(`crates/account-server/src/app.rs`)은 코드를 꺼내고 PKCE를 확인한 뒤 바로 토큰을 만든다. 차단 확인이 없다. 차단은 로그인 콜백(`admitted_account`)과 요청 인증(`authenticate`, `session_account`)에서만 본다. 차단 목록은 시작 때 설정에서 읽으므로, 코드 발급과 교환 사이에 재시작이 끼어야 이 일이 생긴다.

## 확정된 결정

1. 세 항목을 처리한다(사용자, 2026-11-23).
2. 재현과 확인은 결정적 방법으로 한다. 같은 시험을 여러 벌 동시에 돌려 부하를 거는 방식은 쓰지 않는다(AGENTS.md).

## 스스로 정한 결정과 그 이유

1. **#6은 작업을 열지 않는다.** 원인이던 순서 문제를 #530이 고쳤고, 지금 코드에는 경쟁이 남지 않았다. 그 뒤 93번 실행에서 실패가 없다. 시험이나 제품 코드를 더 고칠 것이 없다. 오케스트레이터는 기다림 목록 #6을 "#530으로 해결됨"으로 닫을 수 있다.
2. **작업을 둘로 나눈다.** 요청은 PR 하나를 권했지만 #18이 다른 플랜의 작업과 파일이 겹친다.
   - 같은 탭의 `public-user-data`(플랜 `browser-keys-funnel`, 아직 시작 전)가 `paths`에 `crates/account-server/src/**`를 적었다. #18은 `crates/account-server/src/app.rs`를 고치므로 그 작업과 순서 없이 돌 수 없다.
   - 한 작업으로 묶으면 #7도 `public-user-data`가 끝날 때까지 기다린다. #7은 겹치는 파일이 없으니 지금 돌린다.
3. **#18은 `public-user-data` 뒤에 둔다**(`after`). 겹치는 파일이 그 작업의 `paths` 글롭 안에 있고, 그 작업에는 `shared`가 없다.
4. **차단된 계정의 코드 교환은 다른 쓸 수 없는 코드와 같은 답을 준다.** 400 `invalid_grant`다. 코드는 이미 꺼냈으므로 다시 쓸 수 없다. 커넥터(`crates/server`)는 이 답을 지금처럼 `exchange_failed`로 보여 준다. 커넥터를 고치지 않으니 다른 탭의 작업과 겹치지 않는다. 차단된 사람에게 차단 사실을 따로 알리는 화면은 로그인 콜백(`error=blocked`)이 이미 맡는다. 이 경로는 재시작이 60초 안에 끼는 드문 경우다.
5. **#7은 `sandbox_env()`가 필요한 env만 넘기게 한다.** 허용 목록 방식으로, 실행에 필요한 기본 변수(`PATH`, `HOME`, 로캘 등)만 넘긴다. 정확한 목록은 작업자가 정하고, 로컬 모드와 계정 모드 여정이 모두 도는지로 확인한다. doctor의 실제 호스트 검사(`REAL_IDP_HOSTS`, `account_problems`, `kiwoom.com` 검사)는 그대로 둔다. 검사를 약하게 하지 않고 넘기는 env를 줄여서 고친다.

## 작업

| 작업 | 항목 | 방식 | 이유 | 순서 |
|---|---|---|---|---|
| `vv-sandbox-env` | #7 | `basic`, `minor-fix` | 검증 도구 스크립트의 작은 수정. 넘기는 env를 줄일 뿐 검사 규칙은 바꾸지 않는다 | 바로 시작 |
| `acct-blocked-exchange` | #18 | `poteto`, `minor-fix` | 인증 경로(토큰 발급)를 고친다 | `public-user-data` 뒤 |

두 작업은 겹치는 파일이 없어 서로 병렬이다. `acct-blocked-exchange`만 다른 플랜의 `public-user-data`를 기다린다.

## 범위 밖

- #6에 대한 시험·제품 코드 변경.
- 커넥터(`crates/server/src/account/`)의 오류 문구나 `blocked` 전용 처리.
- 차단 목록을 재시작 없이 바꾸는 기능.
- verify-vally의 다른 검사, 여정, 빌드 절차.

## 사용자가 정해야 하는 결정

없다. 검증을 약하게 하는 변경(시험 삭제, 시간 제한 증가, 검사 축소)은 없다.

참고로, #18을 `public-user-data`보다 먼저 하려면 그 작업의 `paths`에서 `crates/account-server/src/**`를 좁혀야 한다. 이 플랜은 그렇게 하지 않고 순서를 둔다.
