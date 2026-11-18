# ETN 주문을 ETF와 같은 호가 단위와 15:30 뒤 차단으로 다루는 플랜

작성일: 2026-11-19. 승인 시점의 기록이며 구현 중 바뀐 것은 반영하지 않는다.

## 풀려는 문제

작업 symbol-kinds(PR #625)는 ETN·인프라투자금융·뮤추얼펀드를 앱 종목 목록에 넣는다. 그 PR의 리뷰에서 주문 쪽 문제 둘이 나왔다. 오케스트레이터가 알렸고 사용자는 "1·2번 바로 고쳐줘"라고 답했다.

1. ETN 주문이 맞는 가격에서 `off_tick`으로 거절된다. 서버 `crates/server/src/trading/tick.rs`의 `tick_size`는 `SymbolKind::Etf`에만 ETF 호가 단위(2,000원 미만 1원, 2,000원 이상 5원)를 주고, ETN에는 주식 표를 쓴다. 웹 `web/src/features/market-window/tick.ts`의 `tickRuleOf`도 `kind === "etf"`만 ETF 규칙으로 본다. 그래서 호가주문창과 10호가창의 사다리도 ETN 가격을 주식 단위로 늘어놓는다. 받은 호가가 주식 단위에 맞지 않으면 `tickRuleOf`가 ETF 규칙으로 바꾸기는 한다.
2. ETN이 호가주문창의 15:30 뒤 차단에서 빠진다. `web/src/features/order/holdingSummary.ts`의 `isEtfAfterHours`는 `kind !== "etf"`이면 거짓을 준다. 차단할 때 보이는 문구는 "ETF·ETN은 15:30 뒤 거래되지 않습니다"인데 ETN은 막지 않는다.

주식 호가 단위는 언제나 ETF 단위의 배수다. 그래서 1번은 틀린 가격을 받아 주는 문제가 아니고, 맞는 가격을 거절하는 문제다.

## 확정된 결정 (사용자 요청)

- ETN(`SymbolKind::Etn`, TS `"etn"`)은 호가 단위와 15:30 뒤 차단에서 ETF와 같게 다룬다.
- 서버와 웹을 함께 고친다.

## 스스로 정한 결정과 이유

1. **ETN의 호가 단위는 ETF와 같다.** 증권사의 ETN 매매 안내(다올투자증권 「ETN 거래」 안내: <https://www.daolsecurities.com/customer/guide/etnTrade.jsp>)는 ETN에 ETF와 같은 매매제도를 쓴다고 하고, 호가 단위를 2,000원 미만 1원, 2,000원 이상 5원으로 적는다. 2023년 호가 단위 개편 전에는 ETF와 ETN 모두 가격에 상관없이 5원이었다(비즈워치 2022-10-31 기사: <https://news.bizwatch.co.kr/article/market/2022/10/31/0004>). 저장소의 ETF 규칙과 같은 값이므로 새 표를 만들지 않고 ETN을 ETF 규칙에 넣는다.
2. **15:30 뒤 차단 대상도 ETF와 같다.** [호가창 빈 화면 플랜](book-empty.md)이 인용한 키움증권 「거래소 제도개편 안내」는 KRX 애프터마켓(16:00~20:00)이 ETF·ETN을 받지 않는다고 적는다. 지금의 조건(KST 15:30~20:00, NXT 미거래, 장이 열린 날)을 바꾸지 않고 종류만 넓힌다.
3. **서버에는 15:30 뒤 차단에 해당하는 검사가 없어 고치지 않는다.** 주문 검사(`trading/orders.rs`의 `check_terms`, `check_price_band`)는 호가 단위, 1회 한도, 고액 확인, 상·하한가만 본다. 시간 차단은 웹의 호가주문창만 한다. 서버에 시간 차단을 새로 넣는 것은 이 요청 밖이다.
4. **인프라투자금융·뮤추얼펀드는 주식 호가 단위와 지금의 시간 규칙을 그대로 둔다.** 두 종류는 ETF·ETN 같은 상장지수상품이 아니고 투자회사 주권으로 상장된다. 그래서 리츠처럼 주권의 호가 단위표를 쓴다고 판단했다. 키움 공지가 애프터마켓에서 빼는 것도 ETF·ETN과 시장관리 종목뿐이다. 공식 시행세칙 원문은 찾지 못했다. 다만 틀리더라도 결과는 맞는 가격을 거절하는 쪽이다. 주식 단위는 ETF 단위의 배수이기 때문이다. 틀린 가격을 거래소에 보내는 일은 생기지 않는다. 그래서 사용자 결정으로 올리지 않고, 시험으로 지금 규칙을 고정한다.
5. **서버 `tick_size`는 `SymbolKind`를 빠짐없이 나누는 `match`로 쓰게 한다.** 종류가 또 늘면 호가 단위를 정하지 않은 채 주식 표로 떨어지는 일이 이번 문제의 원인이었다. 빠짐없는 `match`는 새 종류가 생기면 컴파일 오류를 낸다. 웹은 ETF·ETN을 묻는 판정 하나를 두고 `tickRuleOf`와 15:30 판정이 함께 쓰게 한다.
6. **ETF만 가리키는 이름은 ETF·ETN을 함께 가리키게 바꾼다.** `isEtfAfterHours`, `EtfSymbol`, `ETF_AFTER_HOURS_TEXT`가 ETN에도 참이 되므로 이름과 뜻이 어긋난다. 새 이름은 작업자가 고르고 `OrderWindow.tsx`는 가져오기와 호출만 고친다.
7. **작업은 하나, 프로필 `minor-fix`, 방식 `basic`.** 서버 한 파일, 웹 세 파일과 그 시험만 고친다. 주문 검사 코드지만 받아 주는 가격이 넓어지는 쪽이고, 넓어진 범위는 거래소 규정과 같다. 상태 저장, 동시성, 새 설계가 없다.
8. **symbol-kinds 뒤에 둔다(`after: ["symbol-kinds"]`).** `SymbolKind::Etn`과 TS `"etn"`이 그 PR에서 생긴다. 이 플랜을 쓴 2026-11-19 시점에 PR #625는 아직 열려 있다(chute 대기).

## 작업

| 작업 | 내용 | 방식 | 이유 | 순서 |
|---|---|---|---|---|
| `etn-order` | 서버 `tick_size`와 웹 `tickRuleOf`·15:30 판정에 ETN을 넣고 시험을 더한다 | `basic` | 파일 몇 개의 작은 버그 수정 | symbol-kinds 뒤 |

같은 탭의 다른 작업과 겹치는 파일은 없다. 순위 창 작업(rank-kind, rank-service, rank-window, screener-kinds)과 차트 연동 작업(xhair-scope, jump-server, bar-jump)의 범위에 `trading/`, `features/order/`, `features/market-window/tick.ts`, `lib/symbol.ts`는 없다. rank-window는 `features/market-window/MarketWindowGate.tsx`를 읽기만 한다.

## 범위 밖

- 서버 주문 검사에 15:30 뒤 차단을 넣는 일.
- ELW, 그 밖에 앱 종목 목록에 없는 상품의 호가 단위.
- 키움이 ETN·인프라·뮤추얼펀드 주문을 실제로 받는지 실측하는 일. 실제 키움 호출은 하지 않는다.
- symbol-kinds 리뷰의 세 번째 발견(`kind=mutualFund` 질의 값을 지키는 시험 없음).

## 사용자가 정해야 하는 결정

없음. 인프라투자금융·뮤추얼펀드의 규칙은 위 4번의 근거로 지금 규칙을 유지한다. 다르게 하려면 플랜 검토에서 알려 주면 된다.
