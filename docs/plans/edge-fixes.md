# 순위 창·종목 종류·십자선·바로가기의 미뤄 둔 가장자리 경우 8건 플랜

작성일: 2026-11-19. 승인 시점의 기록이며 구현 중 바뀐 것은 반영하지 않는다.

## 풀려는 문제

순위 창([ranking-window](ranking-window.md)), 차트 연동·바로가기([chart-sync-jump](chart-sync-jump.md)), ETN 종목 종류([etn-order](etn-order.md))를 구현한 작업들은 리뷰에서 나온 가장자리 경우 몇 건을 고치지 않고 보고서에 "미뤄 둠"으로 남겼다. 오케스트레이터가 그 8건을 보이자 사용자가 "개선해줘"라고 했다. 8건은 다음과 같다(번호는 orch ask 번호, 괄호는 원래 작업).

| 번호 | 원래 작업 | 문제 |
|---|---|---|
| #11 | symbol-kinds | 종목 검색 질의 `kind=mutualFund` 값을 지키는 시험이 없다. `http.rs`의 `"mutualFund"`를 `"mutualfund"`로 바꿔도 모든 시험이 통과한다. 코드는 맞다. |
| #12 | xhair-scope | 레이아웃 메뉴에서 레이아웃 목록 라디오와 십자선 범위 라디오가 한 `role="menu"` 아래 섞여 있다. 머리는 `role="presentation"`이라 화면 읽기 프로그램이 체크된 항목을 둘로 읽는다. 클릭·키보드는 정상이다. |
| #13 | rank-kind | `web/src/persist/restore.ts`가 미저장 초안의 순위 창에서 `ranking.kind`만 검사한다. 종류는 맞고 필드가 틀린 초안(`{kind: "tradeAmount"}`만 있음, `market: "zzz"`, 프로그램에 `market: "all"`)을 열고, 서버가 저장을 거절해 저장이 계속 실패한다. 다른 버전의 앱이나 손상된 브라우저 저장소에서 생긴다. |
| #14 | screener-kinds | `web/dev` 개발용 가짜 서버가 새 빼기 값 `etn`·`infrastructure`·`mutual_fund`를 모른다. `fakeUserData.ts`의 `EXCLUDE_KINDS`가 그 셋이 든 스크린을 거절하고, `fakeScreener.ts`의 `EXCLUDED_KIND`가 그 셋을 종목 종류로 잇지 않는다. |
| #15 | screener-kinds | 마이그레이션 `0022_screen_exclude_new_kinds.sql`이 손상 자료에서 어긋난다. `exclude: null`은 `[null]`이 되고 세 값이 붙지 않는다. `exclude`에 null 항목이 있으면 `NOT IN`이 NULL을 만나 세 값이 붙지 않는다. 저장 목록에 객체가 아닌 JSON 문자열 항목이 있으면 `malformed JSON`으로 실패해 서버가 뜨지 않는다. API로는 만들 수 없는 자료다. |
| #16 | rank-kind | `docs/design-system.md` "창과 묶음" 절의 "종류를 더한다고 배치 JSON이나 DB의 종류 열에 새 마이그레이션을 넣지는 않는다"가 순위 창과 어긋난다. 순위 창은 자기 설정 열 `ranking`을 마이그레이션 0021로 더했다. |
| #17 | jump-server | 어제 세션 중에 받은 일봉 캐시가 자정~07:45에 남아 있을 때 어제 날짜로 바로가기를 하면 그날이 `unadjustedDays`에 들어 "일부 날짜 수정주가 미반영"이 잘못 뜬다. 캐시 시리즈가 그날 봉을 확정 봉이 아니라 진행 중 봉(`current`)으로 갖고 있고, `today_daily`가 읽는 `page_with(Some(before))`는 확정 봉만 준다. |
| #18 | rank-service | 순위 서버 세 건. ① 걷던 요청의 클라이언트가 끊기거나 걷기가 실패하면 같은 조건을 기다리던 요청이 1페이지부터 각자 다시 걷는다. 결과는 맞고 키움 호출만 겹친다. ② 행이 모두 읽히지 않는 페이지가 200, 빈 `rows`, `end` 참으로 나와 장 밖 빈 응답과 구별되지 않는다. ③ ka10095 현재가가 0이면 `price` 0, `changeRate` -100이 나온다. |

## 확정된 결정 (사용자 요청)

- 8건을 모두 고친다.
- 키움 시험은 합성 transport만 쓴다(저장소 규칙).
- 작은 수정이 많으니 작업 수를 적게 묶되, 같은 파일을 두 작업이 겹쳐 고치지 않게 나눈다.

## 스스로 정한 결정과 이유

### 작업 나누기

1. **작업은 넷이고 모두 병렬이다.** 웹 하나(`edge-web`: #12, #13, #14, #16), 서버 자료 하나(`edge-screen-data`: #11, #15), 바로가기 하나(`edge-jump`: #17), 순위 서버 하나(`edge-rank`: #18). 네 작업이 고치는 파일은 겹치지 않는다. 한쪽 결과를 다른 쪽이 쓰지도 않는다. 웹 넷을 한 PR로 묶은 것은 모두 `web/`와 문서 한 문장이고 파일이 서로 닿지 않기 때문이다. 서버 셋은 모듈이 다르고 #18이 가장 크다. 하나로 묶으면 리뷰가 순위 서버 동시성에 묻히므로 나눴다. #11은 시험 한 개라 혼자 두지 않고 같은 서버 자료 묶음(#15)에 넣었다.
2. **방식은 모두 `poteto`다.**
   - `edge-web`: 미저장 초안 복원(상태 저장·자료 검증)이 들어 있다. 나머지 셋(메뉴 그룹, 가짜 서버, 문서)만이면 `basic`이다.
   - `edge-screen-data`: 저장 자료를 바꾸는 마이그레이션이다.
   - `edge-jump`: 시리즈 캐시와 보정 비율을 읽는 경로를 바꾼다. 캐시 자료의 뜻(확정 봉과 진행 중 봉)을 다룬다.
   - `edge-rank`: 같은 조건 걷기를 여럿이 기다리는 동시성 코드다.
3. **프로필은 모두 기본(`implementer`)이다.** 넷 다 고칠 파일이 여럿이고 시험을 새로 써야 한다.

### 항목별 결정

4. **#11은 `crates/server/tests/e2e.rs`의 ETN 시험 옆에 둔다.** 그 시험은 합성 목록의 ETN 520100·인프라 088980을 이미 쓰고, 같은 목록에 뮤추얼펀드 094800이 있다. `kind=mutualFund`로 094800을 찾고, 다른 대소문자(`mutualfund`, `MutualFund`)와 직렬화 이름 착각(`mutual_fund`)은 400이 되는 것을 본다.
5. **#12는 공용 `Menu`에 라디오 묶음 항목을 더하고 레이아웃 메뉴만 그것을 쓴다.** 레이아웃 목록 라디오는 "레이아웃 목록" 묶음, 십자선 라디오 넷은 "십자선 연동" 묶음(`role="group"`, `aria-labelledby`로 머리를 가리킨다)에 넣는다. 다른 메뉴(`heading`을 쓰는 드로잉·관심종목·주문 메뉴, `Select`)는 지금 모양 그대로 둔다. 모든 `heading` 뒤를 자동으로 묶으면 그 메뉴들의 접근성 트리와 e2e 단언이 함께 바뀌어 범위가 커진다. ↑↓·Home·End 이동과 글자 찾기는 묶음을 넘어 지금처럼 모든 항목을 돈다.
6. **#13은 서버 `Ranking` 역직렬화가 받는 값과 같은 기준으로 초안을 검사한다.** 순위 13종마다 있어야 할 필드와 허용 값(시장·거래소·장 구분·정렬·투자자·방향·단위·최소 거래대금·기간, 빼기 두 불리언, 관리종목 불리언)을 확인하는 판정 하나를 `features/ranking/`에 두고 `restore.ts`가 쓴다. 검사를 통과하지 못한 초안은 지금 다른 잘못된 창이 있는 초안과 같게 버리고 서버 레이아웃을 연다(`layoutDirty` 거짓). 고쳐서 살리지 않는다. 초안 전체를 버리는 것은 지금 복원 규칙이고, 이 작업은 검사 기준만 넓힌다. 허용 값 목록은 생성 TS 타입에 `satisfies`로 묶어 종류가 늘면 타입 오류가 나게 한다.
7. **#14는 가짜 서버 두 파일과 그 시험만 고친다.** `EXCLUDE_KINDS`에 세 값을 더하고, `EXCLUDED_KIND`가 `etn`→`etn`, `infrastructure`→`infrastructure`, `mutual_fund`→`mutualFund` 종류로 잇게 한다. 가짜 목록에 그 종류의 종목이 없으면 하나씩 더해 빼기가 실제로 걸리는지 시험한다. `web/dev/**/*.test.ts`는 `vite.config.ts`의 Vitest `include`에 이미 들어 있다.
8. **#15는 새 마이그레이션을 더하지 않고 `0022`를 그 자리에서 고친다.** 근거는 셋이다.
   - 0022는 아직 어디에도 적용되지 않았다. 2026-11-19 이 플랜을 쓸 때 사용자의 실제 DB(`/home/dev/code/vallythevally/data/vally.db`, `data/mock/vally.db`)의 `_sqlx_migrations` 최댓값은 20이다. orch 배포 상태의 마지막 대상 `c5e8f744`에도 0022를 더한 커밋 `2ec55eb5`가 없다.
   - 문자열 항목에서 실패하는 문제는 0022 자체를 고쳐야만 막힌다. 새 0023을 더해도 0022가 먼저 실패한다.
   - 저장소에 적용 전 마이그레이션을 그 자리에서 고친 선례가 있다(`460000af`, 0006의 revision 상한).

   sqlx는 적용된 마이그레이션의 체크섬을 비교한다. 그래서 작업자는 고치기 전과 PR을 올리기 전에 두 DB의 `_sqlx_migrations`를 읽기 전용으로 다시 본다. 이미 22가 있으면 0022를 고치지 않는다. 그때는 `0023`을 새로 더해, 0022가 빠뜨린 경우(`exclude`가 null이거나 null 항목이 있는 스크린)에 세 값을 더한다. 그 DB는 0022를 통과했으니 문자열 항목은 없다.

   손상 자료에서 0022가 할 일은 다음과 같다.
   - `exclude`가 null이거나 없으면 빈 목록으로 보고 세 값을 더한다.
   - null 항목은 그대로 두고 세 값 중 없는 것을 더한다.
   - 객체가 아닌 스크린 항목, 그리고 `exclude`가 배열도 null도 아닌 스크린은 바꾸지 않고 넘어간다.
   - 정상 자료의 결과(순서, 중복 없음, revision 규칙)는 지금과 같다.
9. **#16은 `docs/design-system.md`의 그 문장만 고친다.** 뜻은 이렇다. 종류 열(`kind`)에는 CHECK가 없어 종류만 더할 때는 마이그레이션이 필요 없다. 순위 창처럼 자기 설정을 따로 저장하는 종류는 그 열을 더하는 마이그레이션이 필요하다(0021 `ranking`). [ADR 0019](../adr/0019-layout-is-windows-and-placement.md)의 같은 취지 문장은 `kind` 열에 대한 것이라 맞고, ADR은 결정 당시 기록이라 고치지 않는다.
10. **#17은 캐시의 진행 중 봉이 그사이 확정됐으면 최신 페이지를 다시 받아 확정 봉으로 넣는다.** 일봉은 그날 20:00에 유예를 더한 시각에 확정된다(`Bucket::confirm_at`). 시리즈는 07:45에야 비워진다. 그래서 어제 20:00 전에 만든 시리즈는 자정 뒤에도 어제 봉을 `current`로만 갖고 있다. 그 `current`의 값은 받은 시각(예: 15:00)의 값이라 종가가 최종값이 아닐 수 있다. 그 값을 그대로 확정 봉으로 쓰면 틀린 비율이 나온다. 그래서 키움에서 최신 페이지를 다시 받는다. 지금은 그 봉이 확정 시각을 지났으므로 `split_current`가 확정 봉으로 넣는다. 다시 받는 조건은 "시리즈의 `current`가 지금 시각에 확정돼 있다"이다. 그 밖의 경우에는 키움 호출을 더하지 않는다. 고칠 곳은 바로가기의 `today_daily`일 수도 있고, 같은 상태의 시리즈를 과거 페이지로 읽는 `page_with`일 수도 있다. 작업자가 고르되, `page_with`를 고치면 다른 호출자에도 같은 규칙이 걸린다는 점을 시험으로 확인한다. 확정 규칙(`split_current`, 확정 시각)과 07:45 비우기는 바꾸지 않는다.
11. **#18 ①은 같은 조건의 걷기를 요청 하나의 수명에서 떼어 낸다.** 걷기를 맡은 요청이 끊겨도 걷기는 끝까지 가고, 기다리던 요청은 그 결과를 받는다. 걷기가 실패하면 그 걷기를 기다리던 요청은 같은 오류를 받는다. 각자 1페이지부터 다시 걷지 않는다. 실패한 결과는 지금처럼 캐시에 넣지 않으므로, 실패 뒤에 새로 온 요청은 다시 걷는다. 지금의 우선순위 승격과 8초·60초 규칙은 유지한다.
12. **#18 ②는 행이 있는데 하나도 읽히지 않은 페이지를 키움 프로토콜 오류(503 `protocol`, `ApiFailure::kiwoom_protocol`)로 알린다.** 키움이 빈 목록을 준 페이지(장 밖)는 지금처럼 빈 결과다. 일부 행만 읽히지 않은 페이지는 지금처럼 읽힌 행만 쓰고 경고 로그를 남긴다. 값이 너무 커서 버린 행(`figures` 없음)도 "읽히지 않은 행"으로 센다.
13. **#18 ③은 ka10095 현재가가 0인 종목의 현재가·등락률을 비운다(`null`).** 0원 현재가는 거래가 없거나 값이 없는 표시로 보고, 받지 못한 경우와 같게 다룬다. 실제 키움이 0을 주는지는 실측하지 못했다.

## 작업

| 작업 ID | 항목 | 방식 | 순서 | 고칠 파일 |
|---|---|---|---|---|
| `edge-web` | #12, #13, #14, #16 | poteto | 병렬 | `web/src/features/menu/Menu.tsx`, `web/src/features/layouts/LayoutMenu.tsx`, `web/e2e/win-layouts.spec.ts`, `web/e2e/win-crosshair.spec.ts`, `web/src/persist/restore.ts`·`restore.test.ts`, `web/src/features/ranking/rankingShape.ts`(새)·시험·`rankingKinds.ts`·`rankingChoices.ts`, `web/dev/**`, `docs/design-system.md` |
| `edge-screen-data` | #11, #15 | poteto | 병렬 | `crates/server/tests/e2e.rs`, `crates/server/migrations/0022_screen_exclude_new_kinds.sql`(조건부 `0023_*.sql`), `crates/server/tests/screens.rs` |
| `edge-jump` | #17 | poteto | 병렬 | `crates/server/src/jump_bars.rs`, `crates/server/src/bars.rs`, `crates/server/tests/jump_bars.rs` |
| `edge-rank` | #18 | poteto | 병렬 | `crates/server/src/rankings/**`, `crates/server/tests/rankings.rs`, `crates/server/tests/support/mod.rs`, `docs/kiwoom-rankings-api.md` |

순서를 둔 작업은 없다. 네 작업의 파일이 겹치지 않고, 서로의 결과를 쓰지 않는다.

## 범위 밖

- xhair-scope 보고서의 나머지 두 건: `LayoutSync` 문서 주석이 `crosshairScope`에 맞지 않는 것, 미저장 초안의 잘못된 `crosshairScope` 문자열을 거르지 않는 것. 사용자가 고르라고 받은 8건에 들지 않는다.
- rank-kind 보고서의 `RankingPage.end`와 `limited`가 함께 참일 수 있는 DTO 모양.
- symbol-kinds 보고서의 ETN 호가 단위·15:30 차단. [etn-order](etn-order.md)가 맡는다.
- 마이그레이션 0008의 같은 문자열 항목 실패. 0008은 이미 모든 DB에 적용됐다.
- 순위 서버의 실제 키움 키 거절 코드, 장 밖 응답 모양 실측.

## 사용자가 정해야 하는 결정

- **`edge-screen-data`가 병합될 때까지 vally 배포와 실제 앱 서버 재시작을 미뤄 주세요.** 지금 main에는 고치기 전 0022가 들어 있다. 실제 DB가 그 0022를 먼저 적용한 뒤 고친 0022가 병합되면, sqlx 체크섬이 달라 다음 시작 때 서버가 뜨지 않는다. 작업자는 고치기 전과 PR 전에 실제 DB를 확인해, 이미 적용됐으면 새 마이그레이션 `0023`으로 돌린다. 그래도 PR이 열린 뒤 병합되기 전에 적용되면 막을 수 없다. 미루지 않을 거라면 처음부터 `0023` 방식으로 하라고 알려 주세요. 그 경우 문자열 항목 실패(#15의 셋째)는 0022에 남는다.
- 검증을 약하게 하는 작업(검증 단계 삭제, 시간 제한 증가, `paths` 축소)은 없다.
