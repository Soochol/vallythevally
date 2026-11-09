# 드로잉 제안서: TradingView 수준의 도구 21개와 편집 경험

- **상태**: 제안. 사용자 승인 전이다. 앱 코드, `frontend.md`, `backend.md`, 용어집, ADR은 바꾸지 않았다.
- **작성**: 2026-11-09, #34.
- **요청**: 사용자는 드로잉이 "정말 TradingView처럼 프로페셔널"하기를 원한다(2026-11-09 grilling). 이 문서는 #6 엔진 일꾼이 그대로 명세로 쓴다.
- **근거**: `docs/research/2026-11-09-drawing/`. 근거는 `[접두어:번호]`로 적는다. 접두어와 근거의 세기는 그 폴더의 `README.md`에 있다. 근거 없이 정한 것은 `[설계]`로 적는다.

## 0. 요약

- **도구 21개**: 선 7, 피보나치 2, 도형 5, 주석 3, 측정 4. 이슈 #34의 목록 그대로다.
- **기존 설계는 유지한다.** `(시각, 가격)` 고정 방식, 종목에 붙음, 자동 저장, 메모리 안의 되돌리기, 휴대폰은 보기만이다.
- **기존 설계에서 바꿀 것 다섯 가지**(§8에 이유)
  1. 소수점 논리 index를 x로 바꾸는 일은 라이브러리가 못 한다. 엔진이 직접 계산한다(§6).
  2. 드로잉은 `zOrder: "normal"`에 그린다. `"top"`이면 십자선을 가린다(§6).
  3. 자석에 약·강 두 단계를 둔다. 지금 §3.5의 16px 규칙이 "약"이다(§3.4).
  4. `Drawing` 계약에 `locked`, `hidden`, `periods`, `z`를 더하고 `tool`을 21개로 넓힌다(§5).
  5. 복제는 TradingView처럼 `Ctrl`+끌기다. 이슈는 `Alt`라고 적었다. **사용자가 정한다(Q1).**
- **엔진·도구 경계**: 도구는 **순수 함수 묶음**(`ToolSpec`) 하나다. 점을 화면 도형 목록으로 바꾸고, 핸들과 스타일 칸을 선언한다. 그리기, 클릭 판정, 끌기, 자석, 저장, 되돌리기, 스타일 막대, 설정 창, 개체 목록은 엔진이 한다. 도구 하나를 더하려면 파일 하나와 등록 한 줄, 서버 enum 한 줄이 든다(§7).
- **사용자가 정할 질문 4개**: §10.1.

## 1. 조사의 한계

- tradingview.com은 로그인하지 않으면 그리기 도구를 누를 때 가입 창을 띄운다[O]. 그래서 **직접 써 본 관찰은 없다.**
- 공식 도움말에는 다음이 없다[L, M]. 이 문서에서는 `[설계]`로 정했다.
  - 점을 클릭 두 번으로 찍는지, 눌러 끌어 찍는지
  - 고른 드로잉의 핸들 위치(스크린숏으로 본 추세선·채널·피보나치는 예외)
  - 떠 있는 막대의 버튼 전체 목록과 순서, 오른쪽 클릭 메뉴 항목
- 기본 색·굵기는 Charting Library 값이다[L:CL*, M:S19]. 웹 앱과 같다는 보장은 없다. 이 앱은 어차피 자기 색 토큰을 쓰므로(§5.4) 색은 영향이 작다.

## 2. 도구 목록과 도구별 명세

### 2.1 공통 규칙

- **점 찍기**(기존 §3.5 유지)
  - 점이 고정된 도구는 클릭으로 하나씩 찍어도 되고, 첫 점에서 눌러 끌어 둘째 점에서 놓아도 된다. 셋째 점이 있으면 그다음은 클릭이다[설계].
  - 첫 점을 찍은 뒤에는 마지막 점이 커서를 따라오는 미리보기를 그린다[L:IMG 설명, 도움말 GIF].
  - 그리는 중 `Esc`는 그리던 것을 버린다(기존 §3.2).
- **다 그리면** 선택 도구로 돌아가고 방금 그린 것이 골라진다. 연속 그리기를 켰으면 같은 도구가 남는다(§3.3).
- **핸들**: 고른 드로잉에만 보인다. 지름 8px 원, 테두리는 드로잉 색, 안은 차트 바탕색이다. 클릭 판정은 반지름 6px다[설계].
- **몸통**: 선은 6px 안(기존 §3.5), 채운 도형은 안쪽 전체가 몸통이다. 몸통을 끌면 전체가 옮겨진다.
- **설정 창의 탭**: `스타일 / 글자 / 좌표 / 보이기`. 도구마다 쓰지 않는 탭은 뺀다[L:S1, E:S38·S39]. 롱·숏은 `입력 / 스타일 / 보이기`다[M:S13].
  - **좌표**: 점마다 날짜·시각과 가격을 숫자로 넣는다. TradingView는 봉 번호를 쓰지만[L:S1] 이 앱은 시각으로 저장하므로 시각을 보인다[설계].
  - **보이기**: 봉 주기 9개(1·3·5·15·30·60분, 일·주·월)마다 켜고 끈다. 기본은 모두 켬[E:S16].
- **기본 스타일**: 선 색은 `--draw` 토큰, 굵기 2, 실선[L:CL1, frontend §1.2]. 채움은 같은 색 20%[M:S19]. 글자는 14px[L:CL1].
- **글자를 붙일 수 있는 도구**(추세선 계열, 수평·수직선, 채널, 사각형, 화살표)는 `글자` 탭에서 글자, 색, 크기, 굵게·기울임, 위치를 정한다[L:S1, M:S1].

### 2.2 선 7개

| id | 이름 | 점 | 찍는 법 | 핸들 | 기본 스타일 | 설정 창의 특이 항목 | 단축키 | 근거 |
|---|---|---|---|---|---|---|---|---|
| `trendline` | 추세선 | 2 | 클릭 2번 또는 끌기 | 두 끝[L:IMG1] | 연장 없음, 끝 모양 없음, 통계 끔 | 양 끝 화살표, 연장(없음·왼쪽·오른쪽·양쪽), 가운데 점, 가격 라벨, 통계(가격 차, %, 봉 수, 기간, 각도), 통계 늘 보이기 | `T` | L:S1, L:CL1 |
| `ray` | 광선 | 2 | 같음. 첫 점이 시작, 둘째가 방향 | 두 점 | 오른쪽으로 연장 | 추세선과 같음 | 없음 | L:S2, L:CL2 |
| `extline` | 연장선 | 2 | 같음 | 두 점 | 양쪽으로 연장 | 추세선과 같음. 화살표는 연장을 끈 쪽에만 | 없음 | L:S3, L:CL3 |
| `hline` | 수평선 | 1(가격만 씀) | 클릭 1번 | 클릭한 자리 하나. 끌면 가격만 바뀐다[설계] | 가격 축에 가격 라벨 | 가격 라벨, 글자 정렬 | `H` | L:S4, L:CL4 |
| `hray` | 수평 광선 | 1 | 클릭 1번. 그 시각부터 오른쪽 끝까지 | 시작점 하나 | 가격 라벨, 글자는 선 위 | 수평선과 같음 | 없음 | L:S5, L:CL5 |
| `vline` | 수직선 | 1(시각만 씀) | 클릭 1번 | 하나. 끌면 시각만 바뀐다[설계] | 지표 패널까지 이어 그림, 시간 축에 시각 라벨 | 패널까지 잇기, 시각 라벨, 글자 방향 | `Shift+V` | L:S6, L:CL6 |
| `channel` | 평행 채널 | 3 | 클릭 2번으로 기준선, 셋째 클릭으로 폭 | 기준선 두 끝, 평행선 두 끝, 평행선 가운데(폭)[L:IMG4 세 원, 나머지는 설계] | 가운데 점선 켬, 채움 20% | 가운데 선, 연장 왼쪽·오른쪽, 채움 | 없음 | L:S7, L:CL7 |

- **추세선 계열의 Shift**: 그리는 중 `Shift`를 누르면 둘째 점이 45°의 배수로 맞춰진다[L:S12, E:S42]. 각도는 **화면 픽셀**에서 잰다. 봉 주기나 확대를 바꾸면 45°가 아니게 된다. TradingView도 같다고 본다[추정].
- **채널의 저장**: TradingView는 두 점과 "가격 차"로 둔다[L:S7]. 이 앱은 셋째 점을 `{ t: 첫 점의 t, price: 첫 점 가격 + 가격 차 }`로 저장한다. 봉 주기마다 선의 기울기는 달라도 가격 차는 같기 때문이다[설계].
- **추세선의 가격 라벨·통계**는 고른 동안 축 라벨과 선 옆 상자로 보인다. `통계 늘 보이기`를 켜면 고르지 않아도 보인다[L:S1].

### 2.3 피보나치 2개

| id | 이름 | 점 | 찍는 법 | 핸들 | 근거 |
|---|---|---|---|---|---|
| `fib` | 피보나치 되돌림 | 2 | 클릭 2번 또는 끌기. 두 점이 100%와 0%다(§2.3 아래) | 두 점[L:IMG6] | L:S8, L:CL8 |
| `fibext` | 추세 기반 피보나치 확장 | 3 | 클릭 3번: 움직임의 시작, 끝, 되돌림의 끝 | 세 점[L:IMG8] | L:S9, L:CL9 |

- **수준 기본값**(두 도구 같음)[L:CL8, L:CL9]
  - 켬: 0, 0.236, 0.382, 0.5, 0.618, 0.786, 1, 1.618, 2.618, 3.618, 4.236
  - 끔: 1.272, 1.414, 2, 2.272, 2.414, 3, 3.272, 3.414, 4, 4.272, 4.414, 4.618, 4.764
  - 색은 TradingView 값을 쓴다. 수준이 많아 토큰만으로는 구별되지 않는다. 테마를 바꿔도 같은 색이다[설계].
- **그 밖의 기본값**: 추세선 켬(회색 점선), 수준 선 굵기 2, 수준 사이 채움 켬(투명도 80), 가격과 수준 값 보임, 라벨 왼쪽, 연장 끔, 뒤집기 끔[L:CL8].
- **설정 창**: `스타일 / 좌표 / 보이기`. `글자` 탭이 없다[L:IMG6]. 스타일 탭에 수준 표(값, 색, 켬)가 있다. 수준은 24개까지 둔다[L:S8].
- **설정 창의 다른 항목**: 한 색으로, 채움, 뒤집기, 가격 보이기, 수준 값을 값·%로, 라벨 위치, 글자 크기, 연장 왼쪽·오른쪽[L:S8].
- **로그 축에서의 수준**("로그 축 기준 수준"): TradingView는 로그 축일 때만 고를 수 있다[L:S8]. 이 앱도 같은 칸을 두되, 계산은 가격의 로그로 한다[설계].
- **0%가 어느 점인가**: 도움말 스크린숏 두 장이 서로 다르다[L:미확인]. 이 문서는 **첫 점 = 100%, 둘째 점 = 0%**로 정한다[설계]. 상승을 아래에서 위로 그으면 위 끝이 0%라서 되돌림 비율을 위에서부터 읽는다. `뒤집기`가 이를 반대로 한다.

### 2.4 도형 5개

| id | 이름 | 점 | 찍는 법 | 핸들 | 기본 스타일 | 설정 창의 특이 항목 | 단축키 | 근거 |
|---|---|---|---|---|---|---|---|---|
| `rect` | 사각형 | 2(맞모서리) | 클릭 2번 또는 끌기. `Shift`면 정사각형(화면 픽셀) | 네 모서리, 네 변 가운데[설계] | 테두리 2, 채움 20%, 가운데 선 끔 | 테두리, 가운데 선, 채움, 연장 왼쪽·오른쪽, 글자(가운데) | `R` | M:S1, M:S19 |
| `ellipse` | 타원 | 2(둘러싼 상자의 맞모서리)[설계] | 같음. `Shift`면 원 | 상자 네 변의 가운데[설계] | 테두리 2, 채움 20% | 테두리, 채움 | 없음 | M:S2, M:S19 |
| `arrow` | 화살표 | 2 | 클릭 2번 또는 끌기 | 두 끝 | 오른쪽 끝 화살표 | 추세선과 같은 선·통계 항목, 끝 모양 | 없음 | M:S3, M:S19 |
| `path` | 경로 | 2~100 | 클릭마다 점을 더한다. 마지막 점을 더블클릭하거나 `Esc`로 끝낸다 | 모든 꼭짓점 | 오른쪽 끝 화살표 | 선, 끝 모양 | 없음 | M:S6, M:S19 |
| `brush` | 붓 | 2~1,000 | 누른 채 그리고 놓으면 끝 | 없음. 몸통만 끈다[설계] | 굵기 2, 채움 끔 | 선, 채움 | 없음 | M:S7, M:S19 |

- **경로의 `Esc`**: 그리던 경로에서 `Esc`는 **지금까지 찍은 점으로 끝낸다**[M:S6]. 점이 하나뿐이면 버린다. 다른 도구의 `Esc`(버리기)와 다르다.
- **붓의 점 줄이기**: 놓는 순간 화면 좌표에서 Ramer–Douglas–Peucker로 1px 오차 안에서 점을 줄인다. 그래도 1,000개가 넘으면 오차를 두 배씩 키운다[설계]. 본문 64KB 한도 때문이다(§5.5).
- **타원의 점 수**: TradingView는 공개하지 않았다[M:미확인]. 상자 맞모서리 두 점이면 사각형과 같은 핸들 코드를 쓸 수 있다[설계].

### 2.5 주석 3개

| id | 이름 | 점 | 찍는 법 | 핸들 | 기본 스타일 | 설정 창의 특이 항목 | 단축키 | 근거 |
|---|---|---|---|---|---|---|---|---|
| `text` | 텍스트 | 1 | 클릭하면 그 자리에 입력칸. `Enter` 확정, `Esc` 취소(기존 §3.5) | 없음. 몸통을 끈다 | `--draw` 14px, 바탕·테두리 끔, 줄바꿈 끔 | 글자(색, 크기, 굵게, 기울임), 바탕, 테두리, 줄바꿈 너비 | `X` | M:S8, M:S19 |
| `callout` | 말풍선 | 2: 가리키는 점, 상자 자리 | 클릭 2번 또는 끌기. 다 찍으면 상자에 입력칸 | 두 점 | 흰 글자, 청록 70% 바탕, 테두리 2 | 텍스트와 같음 | 없음 | M:S9, M:S19 |
| `pricelabel` | 가격 라벨 | 1 | 클릭 1번. 상자는 늘 그 가격을 보인다 | 하나 | `--draw` 바탕, 흰 굵은 글자 14px | 글자 색·크기, 바탕, 테두리 | 없음 | M:S10, M:S19 |

- **글자 고치기**: 텍스트·말풍선을 더블클릭하면 입력칸이 다시 열린다[M:S8 "click the text to edit", 더블클릭은 설계].
- **한글 입력**: 입력칸은 DOM `textarea`다. 조합 중인 `Enter`(`event.isComposing`)는 확정으로 보지 않는다. 기존 §3.2의 "한글 입력 상태에서도 같게" 규칙과 같은 문제다[설계].
- **줄바꿈**: `Shift+Enter`가 새 줄이다[설계].

### 2.6 측정 4개

| id | 이름 | 점 | 찍는 법 | 핸들 | 보이는 값 | 설정 창 | 근거 |
|---|---|---|---|---|---|---|---|
| `pricerange` | 가격 범위 | 2 | 클릭 2번 또는 끌기 | 두 점 | 가격 차, % | 선, 테두리, 채움, 가로 연장, 통계 항목, 라벨 | M:S11, M:S12 |
| `daterange` | 기간 범위 | 2 | 같음 | 두 점 | 봉 수, 걸린 시간, 거래량 합 | 같음. 세로 연장 | M:S11, M:S19 |
| `long` | 롱 포지션 | 3 | 클릭 1번이면 진입점에 기본 상자가 놓인다[설계] | 진입(왼쪽), 목표 가격, 손절 가격, 오른쪽 끝(시각) | 수량, 목표·손절의 가격·%, 손익, 손익비 | 입력(계좌 크기, 위험), 스타일, 보이기 | M:S13, M:S15 |
| `short` | 숏 포지션 | 3 | 같음 | 같음 | 같음. 부호가 반대 | 같음 | M:S14, M:S15 |

- **틱은 보이지 않는다.** TradingView는 가격 차를 틱(pips)으로도 보인다[M:S11]. 한국 주식의 호가 단위는 가격대마다 다르다. 가격 차를 틱으로 바꾸면 구간마다 계산이 갈린다. 가격과 %만 보인다[설계].
- **기간 범위의 거래량 합**은 칸이 가진 봉으로 계산한다. 받지 않은 과거 구간이 걸치면 값 대신 `-`를 보인다[설계].
- **롱·숏의 계산**[M:S15]
  - 수량 = ⌊위험 금액 ÷ |진입 − 손절|⌋. 주식이므로 1주 단위다.
  - 위험 금액 = 위험이 %이면 계좌 크기 × %, 금액이면 그 값이다.
  - 손익비 = |목표 − 진입| ÷ |진입 − 손절|.
  - TradingView의 레버리지, 로트 크기, 수량 소수 자릿수는 뺀다. 이 앱은 현물 주식만 본다[설계].
- **롱·숏 기본값**: 계좌 1,000만 원, 위험 2%, 목표·손절은 진입가의 ±5%, 오른쪽 끝은 진입에서 20봉 뒤[설계]. TradingView 기본값(계좌 1000, 위험 25%[M:S19])은 원화와 맞지 않는다.
- **롱·숏 색**: 목표 상자는 `--up`, 손절 상자는 `--down`의 20%다. TradingView는 초록·빨강이다[M:S19]. **사용자가 정한다(Q3).**
- **뒤집기**: 오른쪽 클릭 메뉴의 `롱↔숏 뒤집기`가 진입가를 축으로 목표·손절을 맞바꾸고 도구를 바꾼다[M:S16].

## 3. 편집 경험

### 3.1 고르기

- **클릭**: 드로잉을 클릭하면 그것만 고른다. 빈 곳을 클릭하면 선택을 푼다(기존 §3.5).
- **여러 개**: `Ctrl`+클릭은 선택에 넣고 뺀다. 빈 곳에서 `Ctrl`+끌기는 상자로 고른다[E:S42, E:S8].
- **겹쳤을 때 누가 잡히나**: 고른 드로잉의 핸들, 선, 채운 안쪽 순으로 잡힌다. 같은 종류끼리는 `z`가 큰 것(위에 그린 것)이 이긴다. Lightweight Charts의 `hitTestPriority` 권장값(점 2, 선 1, 영역 0)과 같은 순서다[P: typings].
- **커서**: 몸통 위는 `move`, 핸들 위는 `grab`, 그리는 중은 `crosshair`다. `hitTest`의 `cursorStyle`로 낸다[P: results.json `hitTest`].
- **숨긴 드로잉**은 차트에서 고를 수 없다. 개체 목록에서도 고르지 않고, 그 줄의 눈 버튼으로 다시 보이게 한다(§3.9). **잠긴 드로잉**은 고를 수 있다. 막대에서 잠금을 풀어야 하기 때문이다[설계].

### 3.2 옮기기와 수정키

| 동작 | 결과 | 근거 |
|---|---|---|
| 몸통 끌기 | 전체를 옮긴다. 고른 것이 여럿이면 모두 함께 | 기존 §3.5, E:S4 |
| 핸들 끌기 | 그 점만 옮긴다. 사각형 변 핸들은 한 축만 | 기존 §3.5, 변은 설계 |
| `Shift`+몸통 끌기 | 수평이나 수직으로만 옮긴다. 처음 8px 움직인 방향으로 정한다 | L:S13, E:S42. 8px는 설계 |
| `Shift`+그리기·핸들 끌기 | 추세선 계열·채널은 45° 배수, 사각형은 정사각형, 타원은 원 | L:S12, E:S42 |
| `Ctrl`+몸통 끌기 | 복제한다. 원본은 그 자리에 남고 사본이 옮겨진다. 여럿을 골랐으면 모두 복제 | E:S42, E:S4. **Q1** |
| `Ctrl` 누른 채 그리기·핸들 끌기 | 자석을 잠시 반대로 | 기존 §3.2, L:S14 |
| 화살표 키(고른 것이 있을 때) | `←` `→`는 1봉, `↑` `↓`는 1px만큼의 가격 | E:S42, L:S13. 가격은 설계 |

- **`Ctrl` 하나에 세 뜻**이 있다. 빈 곳 끌기는 상자 고르기, 몸통 끌기는 복제, 점 끌기는 자석 반대다. TradingView와 같다[E:S42]. 엔진은 `pointerdown` 때 무엇을 눌렀는지로 정한다.
- **화살표 키의 1봉**: 지금 봉 주기의 논리 index로 바꿔 1을 더하고 §3.5 규칙으로 `t`를 다시 구한다. 그래서 `t`는 지금 봉 주기의 봉 시작에 붙는다[설계].
- **화살표 키의 ↑↓**: TradingView는 1호가(mintick)다[L:S13]. 한국 호가 단위는 가격대마다 달라서 1px로 한다[설계].
- **잠긴 드로잉**은 옮기기, 핸들 끌기, 화살표 키가 듣지 않는다. 복제는 된다[설계].
- **끄는 동안**은 차트가 스크롤·확대하지 않는다(§6.2).

### 3.3 그리기 모드

- **한 번 그리기**(기본): 다 그리면 선택 도구로 돌아간다(기존 §3.5).
- **연속 그리기**: 왼쪽 도구 막대에 켜고 끄는 버튼을 둔다. TradingView의 "Keep drawing"이다[E:S14]. 켜 두면 도구가 남는다. 기존 §3.5의 "도구를 더블클릭하면 잠김"도 유지한다. 더블클릭은 그 도구 하나만 잠그고 `Esc`나 다른 도구로 풀린다.
- **연속 그리기의 상태**는 `UiState.drawing.keepDrawing`에 저장한다(§5.6).

### 3.4 자석

| 모드 | 시각 | 가격 | 근거 |
|---|---|---|---|
| 끔 | 마우스 x 그대로 | 마우스 y 그대로 | |
| **약**(기본) | 가장 가까운 봉의 시작 | 그 봉의 시·고·저·종 중 가장 가까운 값. **화면 거리 16px 안일 때만**. 밖이면 마우스 y | 기존 §3.5, E:S14 "placed at a distance from the price" |
| **강** | 가장 가까운 봉의 시작 | 그 봉의 시·고·저·종 중 가장 가까운 값. **거리와 상관없이** | E:S14 "Forces drawings to glue to the open, high, low, or close" |

- 지금 §3.5의 규칙이 그대로 **약**이다. 기본은 약이다.
- `G`는 자석을 켜고 끈다(기존). `Shift+G`는 약↔강을 바꾼다[설계]. 왼쪽 도구 막대의 자석 버튼은 펼침 메뉴로 약·강을 고른다[E:S14].
- `Ctrl`을 누르고 있으면 잠시 반대다. 켜져 있으면 끄고, 꺼져 있으면 **마지막으로 고른 세기**로 켠다. TradingView 2019 블로그는 "강"으로 켠다고 썼다[E:S9]. 이 문서는 사용자가 고른 세기를 따른다[설계].
- 자석은 그리기, 핸들 끌기, 몸통 끌기에 모두 적용된다. 몸통을 끌면 **잡은 점**이 붙고 나머지는 같은 만큼 따라간다[설계].
- 자석 상태는 `UiState.drawing.magnet`에 저장한다.

### 3.5 떠 있는 스타일 막대

고른 드로잉 위쪽에 뜬다. 끌어서 자리를 옮길 수 있고, 옮긴 자리는 그 탭이 기억한다[설계]. 여러 개를 골랐으면 **모두가 가진 칸**만 보인다[E:S27].

버튼 순서[설계. TradingView에 있다고 확인된 것은 E:S19·S33·S27·S32·S17]:

1. 선 색(색과 투명도)
2. 채움 색(채움이 있는 도구)
3. 글자 색(글자가 있는 도구)
4. 굵기(1·2·3·4)
5. 선 모양(실선·파선·점선)
6. 알림 만들기(가격으로 정해지는 `hline`, `hray`, `pricelabel`만. §3.10)
7. 설정 창
8. 잠금
9. 지우기
10. `…`: 복제, 숨기기, 순서(맨 앞·앞으로·뒤로·맨 뒤), 보이는 봉 주기, 기본 스타일로 되돌리기

- **도구마다 마지막 스타일 기억**: 막대나 설정 창에서 스타일을 바꾸면 그 값이 그 도구의 다음 기본값이 된다. `UiState.drawing.lastStyle[tool]`에 둔다(§5.6). TradingView에서는 이 동작을 2차 자료로만 확인했다[E:S40].
- **템플릿**(이름 붙여 저장)은 하지 않는다. Charting Library 문서는 이를 상위 상품의 기능으로 적었다[E:S19]. 마지막 스타일 기억으로 대신한다.

### 3.6 오른쪽 클릭 메뉴

드로잉 위에서 오른쪽 클릭하면 그것을 고르고 메뉴를 연다[설계]. TradingView의 "Visual Order" 메뉴[E:S25]를 참고했다.

- 설정…
- 복제
- 잠금 / 잠금 풀기
- 숨기기
- 순서 ▸ 맨 앞으로 / 앞으로 / 뒤로 / 맨 뒤로
- 보이는 봉 주기 ▸ 모두 / 분봉만 / 일·주·월만 / 지금 봉 주기만
- (롱·숏) 롱↔숏 뒤집기
- 지우기

빈 곳에서 오른쪽 클릭하면 `모든 드로잉 숨기기`, `모든 드로잉 잠그기`, `이 종목 드로잉 모두 지우기…`(확인 창)가 있다[설계].

### 3.7 설정 창

- 드로잉을 더블클릭하거나 막대의 설정 버튼으로 연다[L:S11 "double-click or gear"].
- 탭은 §2.1. 바꾸는 즉시 차트에 보이고, `확인`이면 남고 `취소`면 되돌린다[설계].
- 아래 왼쪽에 `기본 스타일로`가 있다. 그 도구의 **처음 기본값**(§5.4의 `defaultStyle`)으로 되돌린다. 마지막 스타일 기억도 그 값으로 바꾼다[설계].

### 3.8 잠금, 숨기기, 순서

- **잠금**: 드로잉마다 둔다(`locked`). 잠긴 것은 옮길 수 없고 `Delete`로 지워지지 않는다. 막대의 지우기는 확인을 묻는다[E:S35].
- **모든 드로잉 잠그기**: 왼쪽 도구 막대의 자물쇠. 켜 두면 모든 드로잉이 잠긴 것처럼 굴고, 새로 그리는 것은 된다. `UiState.drawing.lockAll`이다[E:S14].
- **숨기기**: 드로잉마다 둔다(`hidden`). 숨긴 것은 개체 목록에만 보인다.
- **모든 드로잉 숨기기**: 왼쪽 도구 막대의 눈과 `Ctrl+Alt+H`[E:S42]. `UiState.drawing.hideAll`이다. 숨긴 동안 새로 그리면 숨기기가 풀린다[설계].
- **보이는 봉 주기**: 드로잉마다 둔다(`periods`). 지금 봉 주기가 목록에 없으면 그리지 않는다[E:S16].
- **순서**: 드로잉마다 `z`(실수)를 둔다. 큰 것이 위다. 맨 앞은 최댓값 + 1, 앞으로는 바로 위 두 개의 가운데 값이다. 그래서 순서를 바꿀 때 PUT은 하나다. 실수 간격이 `1e-9`보다 좁아지면 그 종목의 `z`를 1, 2, 3…으로 다시 매기고 모두 PUT한다[설계].

### 3.9 개체 목록

- 오른쪽 관심종목 패널의 위쪽에 `관심종목 | 개체` 탭을 둔다[설계]. TradingView의 Object Tree 자리와 같다[E:S12·S13·S36].
- 활성 칸 종목의 드로잉을 `z`가 큰 것부터 보인다.
- 한 줄: 도구 아이콘, 이름(도구 이름. 글자가 있으면 앞 20자), 눈, 자물쇠, 지우기.
- 줄을 클릭하면 활성 칸에서 그 드로잉을 고르고 화면 안으로 스크롤한다. 숨긴 드로잉의 줄은 흐리게 보이고 클릭해도 고르지 않는다. `Ctrl`+클릭은 여러 개 고르기다[E:S8].
- 끌어서 순서를 바꾼다. 놓은 자리의 위·아래 `z` 가운데 값을 준다.
- 그룹 묶기와 이름 바꾸기는 하지 않는다[설계]. TradingView에는 있다[E:S12·S13].

### 3.10 알림 만들기

- 막대의 `알림 만들기`는 기존 §3.5에 있다. `AlertCondition`은 가격 조건(`kind: "price"`)만 있다(backend §7.3).
- 그래서 버튼은 가격 하나로 정해지는 `hline`, `hray`, `pricelabel`에만 보인다. 누르면 그 가격으로 알림 대화상자(frontend §3.8)가 열린다.
- 추세선에 닿으면 울리는 알림은 TradingView에 있다[L:S1~S9 "Add alert"]. 이 앱은 하지 않는다. 서버가 드로잉 기하를 해석해야 하기 때문이다. 필요하면 #8 뒤 새 이슈로 둔다.

### 3.11 되돌리기와 다시 하기

- `Ctrl+Z`, `Ctrl+Y`, `Ctrl+Shift+Z`(기존 §3.2). 기록은 탭 메모리에만, 최대 100개(기존 §5.3).
- **한 번의 동작이 한 칸**이다. 여러 개를 함께 옮기거나 지우면 한 번에 되돌린다. 그래서 기록 한 칸은 `DrawingOp[]`가 된다(§8).
- **기록에 들어가는 것**: 만들기, 지우기, 옮기기, 핸들 끌기, 스타일·글자·좌표 바꾸기, 잠금, 숨기기, 순서, 보이는 봉 주기.
- **들어가지 않는 것**: 선택, 모든 드로잉 숨기기·잠그기, 자석, 연속 그리기, 마지막 스타일 기억.
- **다른 탭이 바꾼 드로잉**: 되돌리기 직전에 캐시의 `updatedAt`이 기록의 `after.updatedAt`과 다르면 그 칸을 건너뛰고 `다른 곳에서 바뀐 드로잉이라 되돌리지 않았습니다` 알림을 띄운다[설계]. 여러 쓰는 이가 공유하는 상태이므로 #6 엔진의 architect 승인 지점에서 확정한다.
- **설정 창**은 `확인`을 누를 때 한 칸이 된다. 창 안에서 바꾸는 중간 값은 기록하지 않는다.

### 3.12 휴대폰

보기만 한다(#11, 기존). 숨김·보이는 봉 주기·순서는 같게 적용한다. 고르기, 핸들, 막대는 없다.

### 3.13 하지 않는 것

| 무엇 | TradingView | 이유 |
|---|---|---|
| 복사·붙여넣기(`Ctrl+C`/`Ctrl+V`) | 있다[E:S42] | 같은 종목 안은 복제가 대신한다. 이슈 #34 범위에 없다 |
| 템플릿 | 상위 상품 기능[E:S19] | 마지막 스타일 기억이 대신한다 |
| 드로잉 알림(추세선 닿기) | 있다 | §3.10 |
| 개체 목록의 그룹 | 있다[E:S12] | 개인용 앱의 드로잉 수에서 이득이 작다 |
| 드로잉 동기화 모드(칸 하나, 레이아웃, 전체) | 있다[E:S11·S37] | 이 앱은 언제나 종목에 붙는다(ADR 0007, 기존 §3.5) |
| 시연 커서(`Alt`+그리기), 지우개 | 있다[E:S42] | 범위 밖 |
| 지표 값에 붙는 자석 | 있다[E:S14] | 범위 밖 |

## 4. 단축키

차트에 초점이 있고 입력칸이 아닐 때만 듣는다(기존 §3.2). `event.code`로 판단한다.

| 키 | 동작 | 기존 §3.2 | TradingView[E:S42] |
|---|---|---|---|
| `V` | 선택 도구 | 있음 | 없음 |
| `T` | 추세선 | 있음 | `Alt+T` |
| `H` | 수평선 | 있음 | `Alt+H` |
| `Shift+V` | 수직선 | 있음 | `Alt+V` |
| `R` | 사각형 | 있음 | `Shift+Alt+R` |
| `F` | 피보나치 되돌림 | 있음 | `Alt+F` |
| `X` | 텍스트 | 있음 | 없음 |
| `G` | 자석 켜기/끄기 | 있음 | 없음 |
| `Shift+G` | 자석 약↔강 | **새로** | 없음 |
| `Ctrl` 누르고 있기 | 그리기·점 끌기 동안 자석 반대로 | 있음 | 같음 |
| `Shift`(그리는 중) | 45°, 정사각형, 원 | **새로** | 같음 |
| `Shift`+끌기 | 수평·수직으로만 옮기기 | **새로** | 같음 |
| `Ctrl`+몸통 끌기 | 복제 | **새로**(이슈는 `Alt`, Q1) | 같음 |
| `Ctrl`+클릭 / `Ctrl`+빈 곳 끌기 | 여러 개 고르기 / 상자로 고르기 | **새로** | 같음 |
| `←` `→` `↑` `↓` | 고른 것이 있으면 옮기기. 없으면 기존대로 십자선 | **바뀜** | 같음 |
| `Delete` / `Backspace` | 고른 것 지우기(잠긴 것은 빼고) | 있음 | 같음 |
| `Ctrl+Z` / `Ctrl+Y`, `Ctrl+Shift+Z` | 되돌리기 / 다시 하기 | 있음 | `Ctrl+Z` / `Ctrl+Y` |
| `Ctrl+Alt+H` | 모든 드로잉 숨기기 켜고 끄기 | **새로** | 같음 |
| `Esc` | 그리던 것 버리기(경로는 끝내기), 선택 풀기 | 있음 | 단축키 창에 없음 |
| 더블클릭(드로잉) | 설정 창. 텍스트·말풍선은 글자 고치기 | **새로** | 설정 창은 같음[L:S11] |

- **도구 단축키는 늘리지 않는다.** 나머지 14개는 왼쪽 도구 막대로 고른다. TradingView도 단축키가 있는 도구는 7개뿐이다[E:S42].
- **TradingView의 `Alt` 단축키를 별칭으로 받을지는 사용자가 정한다(Q2).** 받으면 `Alt+T`, `Alt+H`, `Alt+J`(수평 광선), `Alt+V`, `Alt+F`, `Shift+Alt+R`이 더해진다. `Alt+A`(알림), `Alt+W`(관심종목)와는 겹치지 않는다. Chrome이 `Alt+F`를 메뉴 열기로 먼저 가져가는지는 확인하지 않았다[추정. 엔진 e2e에서 확인한다].
- **충돌 확인**: 새 키 중 `Shift+G`, `Ctrl+Alt+H`는 §3.2 표와 겹치지 않는다. 이 PC(GNOME)는 창 끌기 수정키가 `Super`라서(`gsettings ... mouse-button-modifier` = `'<Super>'`) `Ctrl`·`Alt`+끌기가 브라우저까지 온다[측정].

## 5. 저장 모양

### 5.1 지금 계약과의 차이

지금 계약은 `backend.md` §8.2 "드로잉 (#6)"과 §7.2의 `drawings` 표다. **서버에는 아직 드로잉 표도 경로도 없다.** `crates/server/migrations/`에는 `0001_user_data.sql`과 `0002_save_revision.sql`뿐이고 둘 다 `drawings`를 만들지 않는다[측정: `grep -i drawing`이 비어 있음]. 그래서 **옮길 데이터가 없다.** 마이그레이션은 #6이 처음 만드는 `0003`에 새 모양을 바로 쓰는 것이다.

| 항목 | 지금 계약 | 제안 | 이유 |
|---|---|---|---|
| `tool` | 6개, SQL `CHECK` | 21개. SQL `CHECK`를 빼고 Rust enum으로 검사 | SQLite에서 `CHECK`를 바꾸려면 표를 다시 만들어야 한다. 도구를 더할 때마다 표를 다시 만들지 않는다 |
| `points` | 도구마다 1~2개 | 도구마다 정해진 수, 경로 2~100, 붓 2~1,000 | §2 |
| `text` | `text` 도구만 | `text`, `callout`과 글자를 붙일 수 있는 도구 | §2.1 |
| `style` | `unknown`, 64KB | 그대로. 모양은 도구가 정한다(§5.4) | 서버가 해석하지 않는다(backend §7 첫머리의 원칙) |
| `locked` | 없음 | `boolean` | §3.8 |
| `hidden` | 없음 | `boolean` | §3.8 |
| `periods` | 없음 | `Period[] \| null`. `null`이면 모두 | §3.8 |
| `z` | 없음 | `number`(실수) | §3.8 |
| 본문 한도 | `style`만 64KB | PUT 본문 전체 64KB | 붓의 점 때문이다(§5.5) |

`locked`, `hidden`, `periods`, `z`를 `style` 안에 두지 않고 열로 둔 까닭: 엔진이 도구와 상관없이 읽는 값이고, 개체 목록과 그리기 순서가 모든 도구에 대해 같은 자리에서 읽는다. `style`은 도구 묶음 PR마다 모양이 늘어나는 곳이다.

### 5.2 새 계약

```ts
type DrawingTool =
  | "trendline" | "ray" | "extline" | "hline" | "hray" | "vline" | "channel"
  | "fib" | "fibext"
  | "rect" | "ellipse" | "arrow" | "path" | "brush"
  | "text" | "callout" | "pricelabel"
  | "pricerange" | "daterange" | "long" | "short";

interface Drawing {
  id: Uuid;
  symbol: SymbolCode;
  tool: DrawingTool;
  points: DrawingPoint[];
  text: string | null;
  style: unknown;
  locked: boolean;
  hidden: boolean;
  periods: Period[] | null;
  z: number;
  updatedAt: UnixSeconds;
}
interface DrawingPoint { t: UnixSeconds; price: number }

// GET    /api/drawings?symbol=005930   → Drawing[]
// PUT    /api/drawings/:id   본문: Omit<Drawing, "updatedAt">  → Drawing   (본문 64KB 이하)
// DELETE /api/drawings/:id             → 204
```

```sql
CREATE TABLE drawings (
  id         TEXT    PRIMARY KEY,
  symbol     TEXT    NOT NULL,
  tool       TEXT    NOT NULL,
  points     TEXT    NOT NULL CHECK (json_valid(points)),
  text       TEXT,
  style      TEXT    NOT NULL CHECK (json_valid(style)),
  locked     INTEGER NOT NULL DEFAULT 0 CHECK (locked IN (0, 1)),
  hidden     INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0, 1)),
  periods    TEXT    CHECK (periods IS NULL OR json_valid(periods)),
  z          REAL    NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX drawings_by_symbol ON drawings (symbol);
```

- **서버가 받을 때 검사하는 것**(경계에서 한 번)
  - `tool`이 `DrawingTool` enum에 있다.
  - `points` 수가 그 도구의 범위 안이다(§5.3). `t`는 정수, `price`는 유한한 수다.
  - `periods`의 값이 `Period`다. 빈 배열은 거절한다(아무 데도 안 보이는 드로잉은 `hidden`으로 둔다).
  - `z`가 유한한 수다.
- **`data_changed`**는 지금처럼 드로잉 하나마다 `{ entity: "drawing", id }`다. 여러 개를 함께 바꾸면 PUT이 여러 번이고 이벤트도 여러 번이다. 받는 탭은 `["drawings", symbol]` 질의를 무효로 하므로 TanStack Query가 한 번으로 묶는다. 묶음 경로(`PUT /api/drawings`)는 만들지 않는다[설계].

### 5.3 도구별 점

| tool | 점 수 | 뜻 |
|---|---|---|
| `trendline` `ray` `extline` `arrow` | 2 | 두 끝. `ray`는 `[0]`이 시작 |
| `hline` | 1 | `price`만 쓴다. `t`는 찍은 시각(설정 창 좌표 탭에서 숨김) |
| `hray` | 1 | 시작 |
| `vline` | 1 | `t`만 쓴다. `price`는 찍은 가격 |
| `channel` | 3 | `[0]` `[1]`은 기준선, `[2]`는 `{ t: [0].t, price: [0].price + 폭 }` |
| `fib` | 2 | `[0]` = 100%, `[1]` = 0% |
| `fibext` | 3 | 움직임의 시작, 끝, 되돌림의 끝 |
| `rect` `ellipse` | 2 | 맞모서리 |
| `path` | 2~100 | 꼭짓점 순서대로 |
| `brush` | 2~1,000 | 줄인 뒤의 점(§2.4) |
| `text` `pricelabel` | 1 | 글자 상자의 왼쪽 위 / 가리키는 가격 |
| `callout` | 2 | `[0]` 가리키는 점, `[1]` 상자의 왼쪽 위 |
| `pricerange` `daterange` | 2 | 시작, 끝 |
| `long` `short` | 3 | `[0]` 진입 `{ t: 시작, price: 진입가 }`, `[1]` `{ t: 끝, price: 목표가 }`, `[2]` `{ t: 끝, price: 손절가 }` |

### 5.4 스타일 모양

`style`은 도구가 정한다. 공통 조각:

```ts
type Color = string;   // "#RRGGBB", "#RRGGBBAA", 또는 "$draw" "$up" "$down" 같은 테마 토큰
type Dash = "solid" | "dashed" | "dotted";
interface Stroke { color: Color; width: 1 | 2 | 3 | 4; dash: Dash }
interface Fill { on: boolean; color: Color; opacity: number }       // 0~1
interface TextStyle { color: Color; size: number; bold: boolean; italic: boolean }
type Extend = "none" | "left" | "right" | "both";
type LineEnd = "plain" | "arrow";
interface Stats { priceDiff: boolean; percent: boolean; bars: boolean; duration: boolean; angle: boolean; always: boolean }
```

- **테마 토큰 색**: 기본값은 `"$draw"`처럼 토큰을 가리킨다. 그래서 기본 색 드로잉은 테마를 바꾸면 따라 바뀐다. 사용자가 고른 색은 `#RRGGBB`로 남는다[설계].
- **모든 스타일에 `v: 1`**을 둔다. `parseStyle`은 모르는 키를 지우지 않고, 빠진 키는 기본값으로 채운다. 저장된 것을 고치지 않고 읽기만 한다[설계].

도구별(이름 없는 칸은 위 공통 조각):

| tool | 스타일 |
|---|---|
| `trendline` `ray` `extline` `arrow` | `{ v, line: Stroke, extend: Extend, ends: { left: LineEnd, right: LineEnd }, middlePoint: boolean, priceLabels: boolean, stats: Stats, label: TextStyle }` |
| `hline` `hray` | `{ v, line: Stroke, priceLabel: boolean, label: TextStyle & { align: "left" \| "center" \| "right"; vAlign: "top" \| "middle" \| "bottom" } }` |
| `vline` | `{ v, line: Stroke, allPanes: boolean, timeLabel: boolean, label: TextStyle & { orientation: "horizontal" \| "vertical" } }` |
| `channel` | `{ v, line: Stroke, middle: Stroke & { on: boolean }, fill: Fill, extend: Extend, label: TextStyle }` |
| `fib` `fibext` | `{ v, trend: Stroke & { on: boolean }, levels: { value: number; color: Color; on: boolean }[], levelWidth: 1\|2\|3\|4, levelDash: Dash, oneColor: Color \| null, fill: { on: boolean; opacity: number }, extend: Extend, reverse: boolean, showPrices: boolean, showLevels: "value" \| "percent" \| "off", labelSide: "left" \| "right", fontSize: number, logScale: boolean }` |
| `rect` | `{ v, border: Stroke, fill: Fill, middle: Stroke & { on: boolean }, extend: Extend, label: TextStyle }` |
| `ellipse` | `{ v, border: Stroke, fill: Fill }` |
| `path` | `{ v, line: Stroke, ends: { left: LineEnd, right: LineEnd } }` |
| `brush` | `{ v, line: Stroke, fill: Fill }` |
| `text` `callout` | `{ v, text: TextStyle, background: Fill, border: Stroke & { on: boolean }, wrapWidth: number \| null }` |
| `pricelabel` | `{ v, text: TextStyle, background: Fill, border: Stroke & { on: boolean } }` |
| `pricerange` `daterange` | `{ v, line: Stroke, border: Stroke & { on: boolean }, fill: Fill, extend: boolean, stats: { priceDiff, percent, bars, duration, volume: boolean }, label: TextStyle & { background: Color } }` |
| `long` `short` | `{ v, accountSize: number, risk: { kind: "percent" \| "amount"; value: number }, line: Stroke, target: Fill, stop: Fill, text: TextStyle, showStats: boolean, compact: boolean }` |

### 5.5 크기

- PUT 본문 64KB 안. 점 하나는 JSON으로 `{"t":1762300000,"price":193400.5}` 약 35바이트다[계산]. 붓 1,000점은 약 35KB, 피보나치 24수준 스타일은 약 2KB다[계산].
- 서버는 64KB를 넘으면 `413 payload_too_large`다(backend §8.1 오류 표에 드로잉 본문 한도를 더한다).

### 5.6 `UiState`에 더하는 것

`UiState`는 모르는 키를 그대로 저장하고 64KB 한도다(backend `UiState`). 서버를 고치지 않고 키 하나를 더한다.

```ts
interface UiState {
  // …기존
  drawing?: {
    magnet: boolean;
    magnetStrength: "weak" | "strong";    // 끈 동안에도 남는다. G와 Ctrl이 켤 때 이 세기로 켠다
    keepDrawing: boolean;
    lockAll: boolean;
    hideAll: boolean;
    lastStyle: Partial<Record<DrawingTool, unknown>>;   // 도구마다 마지막 스타일
  };
}
```

- 21개 도구의 마지막 스타일은 대부분 1KB 아래다. 피보나치 두 개가 각각 약 2KB다[계산]. 한도 안이다.

## 6. Lightweight Charts로 되는 것과 안 되는 것

`web/`에 설치된 5.2.1로 실험했다[P]. headless Chromium, 900×500 캔버스다.

### 6.1 결과

| 질문 | 결과 | 엔진에 주는 뜻 |
|---|---|---|
| `hitTest`의 id가 클릭 이벤트에 오나 | 온다. `subscribeClick`의 `hoveredInfo.objectId`[P: results.json] | 클릭으로 고르는 데 쓸 수 있다. 다만 누르기·끌기에는 이 이벤트가 없다 |
| `cursorStyle`이 적용되나 | 된다[P] | 커서는 `hitTest`에서 낸다 |
| primitive에 누르기·끌기 API | 없다[P: typings] | 차트 요소에 `pointerdown`(capture)을 달고 엔진이 직접 `hitTest`를 부른다 |
| 끄는 동안 차트 스크롤 막기 | `applyOptions({ handleScroll: false, handleScale: false })`로 된다. 선 끌기에서 보이는 범위가 그대로였고, 빈 곳 끌기는 평소처럼 스크롤했다[P: results.json `drag`] | `pointerdown`에서 끄고 `pointerup`·`pointercancel`에서 켠다 |
| `zOrder` 세 층 | `bottom`은 봉 아래, `normal`은 봉 위·십자선 아래, `top`은 십자선 위[P: results.json, results3.json] | 드로잉은 `normal`. §8 |
| `priceAxisViews`, `timeAxisViews` | 둘 다 축에 라벨을 그린다[P: axis-labels.png] | 수평선 가격 라벨, 수직선 시각 라벨, 고른 드로잉의 점 라벨 |
| `autoscaleInfo` | 가격 축 범위를 넓힌다[P] | 쓰지 않는다. 드로잉 때문에 봉이 작아지면 안 된다[설계] |
| 소수점 논리 index를 x로 | **안 된다.** `logicalToCoordinate(250.25)`가 `0`[P: results3.json]. 소스가 정수가 아니면 `0`을 돌려준다(`lightweight-charts.development.mjs:6163`) | 엔진이 직접 계산한다(§6.3) |
| x를 소수점 논리 index로 | **안 된다.** `coordinateToLogical`은 `Math.ceil`한 정수다[P: results2.json, 소스 `:6183`] | 엔진이 직접 계산한다 |
| 마지막 봉 뒤의 정수 index를 x로 | 된다. 마지막 봉 299에 5를 더한 304가 x 868이 됐다[P] | §3.5 규칙 3(미래 봉 경계)이 쓸 수 있다 |
| 지표 패널까지 이어지는 수직선 | series primitive는 가격 패널에만 그린다. pane마다 `IPaneApi.attachPrimitive`가 있다[P: typings] | `vline`의 `allPanes`는 엔진이 pane마다 붙이는 얇은 primitive로 그린다 |

### 6.2 비용

primitive 하나에 모두 담기와 드로잉마다 primitive 하나를 비교했다[P: results2.json]. 봉 2,000개 중 1,000개가 보이고, 스크롤 120프레임의 평균이다.

| 드로잉 수 | 하나에 모두 | 드로잉마다 하나 |
|---|---|---|
| 100 | 0.30ms | 0.34ms |
| 500 | 0.31ms | 0.89ms |
| 2,000 | 0.92ms | 2.40ms |

- 숫자는 한 프레임의 그리기 명령 시간과 좌표 변환 시간을 더한 것이다. 래스터화와 합성은 들어 있지 않다. 프레임 간격은 모든 경우에 60Hz 상한(16.7ms)이어서 그것으로는 차이를 볼 수 없었다[P: README].
- 라이브러리는 마우스가 움직일 때마다 primitive마다 `hitTest`를 부른다. 드로잉 500개를 primitive 500개로 두면 60번 움직이는 동안 30,000번 불렸다[P: results.json].
- **결론**: 칸마다 **드로잉 층 primitive 하나**(`DrawingLayer`)에 모두 담는다. 4칸에 드로잉 500개씩이라도 프레임 예산의 10%에 못 미친다[추정: 위 숫자 × 4].

### 6.3 소수점 index 변환

Lightweight Charts는 봉 간격이 한 화면 안에서 같다. 그래서 정수 index 하나의 좌표와 봉 간격으로 바꾼다.

```ts
// logical → x
const k = Math.floor(logical);
const x = timeScale.logicalToCoordinate(k as Logical)! + (logical - k) * timeScale.options().barSpacing;

// x → logical
const k0 = timeScale.coordinateToLogical(x)!;   // 정수
const logical = k0 + (x - timeScale.logicalToCoordinate(k0)!) / timeScale.options().barSpacing;
```

`fromScreen`은 이렇게 얻은 소수 index를 §3.5의 봉 구간으로 거꾸로 바꾼 뒤 `t`를 **정수 초로 반올림**한다. 서버는 정수가 아닌 `t`를 거절한다(§5.2).

이 두 함수를 `chart/drawings/anchor.ts` 한 곳에 두고 테스트로 고정한다. 정수에서 라이브러리 값과 같고, `k + 0.25`에서 봉 간격의 1/4만큼 오른쪽인지 본다.

## 7. 엔진과 도구의 경계

### 7.1 도구가 내는 것: `ToolSpec`

도구는 상태를 갖지 않는다. 엔진이 부르는 순수 함수와 선언만 낸다.

```ts
type Placement =
  | { kind: "points"; count: 1 | 2 | 3; shift?: "angle45" | "square" }
  | { kind: "polyline"; min: 2; max: 100 }
  | { kind: "freehand"; max: 1000 };

interface ScreenPoint { x: number; y: number }

/** 엔진이 그리고 클릭 판정하는 화면 도형. 도구는 캔버스를 만지지 않는다. */
type Shape =
  | { kind: "segment"; a: ScreenPoint; b: ScreenPoint; stroke: Stroke; extend?: Extend; ends?: { left: LineEnd; right: LineEnd } }
  | { kind: "polyline"; points: ScreenPoint[]; stroke: Stroke; closed: boolean; fill?: Fill }
  | { kind: "rect"; a: ScreenPoint; b: ScreenPoint; stroke?: Stroke; fill?: Fill; extend?: Extend }
  | { kind: "ellipse"; a: ScreenPoint; b: ScreenPoint; stroke?: Stroke; fill?: Fill }
  | { kind: "text"; at: ScreenPoint; text: string; style: TextStyle; box?: { background?: Fill; border?: Stroke; wrapWidth?: number | null } }
  | { kind: "hband"; y1: number; y2: number; x1: number; x2: number; fill: Fill };

interface AxisLabel { axis: "price" | "time"; value: number; text: string; color: Color }

interface ToolContext {
  toScreen(p: DrawingPoint): ScreenPoint | null;   // §3.5 규칙과 §6.3. 첫 봉 앞이면 null
  fromScreen(s: ScreenPoint): DrawingPoint;
  paneWidth: number;
  formatPrice(p: number): string;
  formatTime(t: UnixSeconds): string;
  barsBetween(t1: UnixSeconds, t2: UnixSeconds): { count: number; volume: number | null };
  logScale: boolean;
}

interface HandleSpec {
  at: ScreenPoint;
  /** 핸들을 끌어 간 자리(자석 적용 뒤)를 받아 새 점 목록을 낸다. */
  move(points: DrawingPoint[], to: DrawingPoint, ctx: ToolContext): DrawingPoint[];
  shift?: "angle45" | "square" | "axis";
}

interface StyleField<S> { /* 엔진이 아는 칸 종류: color, fill, stroke, width, dash, toggle, select, number, text, levels */ }

interface ToolSpec<S> {
  tool: DrawingTool;
  group: "line" | "fib" | "shape" | "note" | "measure";
  label: string;                       // 도구 막대, 개체 목록
  icon: IconId;
  hotkey?: HotkeyId;
  placement: Placement;
  hasText: boolean;
  defaultStyle(): S;
  parseStyle(raw: unknown): S;
  barFields: (keyof S)[];              // 떠 있는 막대에 보일 칸
  settings: { tab: "style" | "text" | "inputs"; fields: StyleField<S>[] }[];
  shapes(points: DrawingPoint[], style: S, text: string | null, ctx: ToolContext): Shape[];
  handles(points: DrawingPoint[], style: S, ctx: ToolContext): HandleSpec[];
  axisLabels(points: DrawingPoint[], style: S, ctx: ToolContext, selected: boolean): AxisLabel[];
}
```

- `StyleField`의 칸 종류는 엔진이 정해 두고 설정 창을 그린다. 도구는 칸을 고르기만 한다. 피보나치·채널의 수준 표(`levels`)도 엔진의 칸 종류다. 두 묶음 PR이 따로 만들면 서로 기다려야 해서다.
- `Shape`의 종류도 엔진이 정한다. 클릭 판정은 엔진이 `Shape`마다 한다(선은 6px, 채운 것은 안쪽). 도구는 판정 코드를 쓰지 않는다.
- 세 가지 `Placement`의 상태 기계는 모두 엔진이 만든다. 경로와 붓을 쓰는 도구는 도형 묶음에만 있지만, 상태 기계는 엔진의 단위 테스트로 고정한다.

### 7.2 엔진 PR이 맡을 것

- `chart/drawings/`
  - `DrawingLayer.ts`: 칸마다 하나인 series primitive(`zOrder: "normal"`). `Shape` 그리기, 클릭 판정, 핸들, 축 라벨. `vline` 패널 잇기용 pane primitive
  - `anchor.ts`: §3.5 규칙과 §6.3
  - `magnet.ts`: 약·강
  - `interaction.ts`: `pointerdown`/`move`/`up` 상태 기계. 그리기 3종, 고르기(클릭, `Ctrl`+클릭, 상자), 몸통·핸들 끌기, `Shift`·`Ctrl` 수정키, 화살표 키, 스크롤 끄고 켜기
  - `tools/index.ts`: `ToolSpec` 등록 표
- 저장: `Drawing` 계약(§5.2), 서버 `0003` 마이그레이션과 경로, ts-rs 타입, `data_changed`
- 스토어: `selection`(도구 21개, 여러 개 선택, 자석 켬/끔과 세기), `drawingHistory`(한 칸 = `DrawingOp[]`), `UiState.drawing`
- 화면: 왼쪽 도구 막대(묶음별 펼침, 자석·연속 그리기·잠그기·숨기기·휴지통), 떠 있는 막대, 오른쪽 클릭 메뉴, 설정 창 틀(좌표·보이기 탭과 칸 종류 전부), 개체 목록, 글자 입력칸(한글 조합)
- 대표 도구: `trendline`, `hline`(이슈 #6)
- e2e: 일봉에 그은 추세선이 60분봉에서 같은 시각·가격에 보인다, 새로고침 뒤에도 남는다, 핸들 끌기, `Shift` 45°, 복제, 되돌리기·다시 하기, 잠금, 숨기기, 순서, 여러 개 선택, 개체 목록
- architect 승인 지점을 켠다(이슈 #6, §3.11의 공유 상태)

### 7.3 도구 묶음 PR 4개

엔진이 병합된 뒤 넷이 동시에 간다. 서로 같은 파일을 고치지 않는다. 등록 표와 서버 enum은 줄 단위 추가라 병합 충돌이 작다.

| 묶음 | 도구 | 더 필요한 것 |
|---|---|---|
| 선 | `ray` `extline` `hray` `vline` `channel` | `vline`의 시각 라벨과 패널 잇기는 엔진에 있다 |
| 피보나치 | `fib` `fibext` | 로그 축 수준 계산 |
| 도형 | `rect` `ellipse` `arrow` `path` `brush` | 붓 점 줄이기(RDP) |
| 주석·측정 | `text` `callout` `pricelabel` `pricerange` `daterange` `long` `short` | 롱·숏 계산, 기간 범위의 `barsBetween` |

### 7.4 도구 하나를 더하는 법

1. `web/src/chart/drawings/tools/<id>.ts`에 `ToolSpec`을 쓴다.
2. `tools/index.ts`에 한 줄 더한다.
3. 서버 `DrawingTool` enum에 한 줄, 점 수 범위 표에 한 줄 더한다. ts-rs가 프런트 타입을 다시 만든다.
4. 아이콘 하나.
5. 테스트: `shapes`·`handles`의 단위 테스트(점을 넣고 화면 도형을 확인), e2e 하나(그리고 새로고침해도 남아 있음).

SQL은 고치지 않는다(§5.1의 `CHECK` 제거).

## 8. 승인 뒤 기존 문서에서 고칠 곳

엔진 일꾼이 #6 PR에서 고친다.

| 문서·절 | 지금 | 고칠 것 | 이유 |
|---|---|---|---|
| `frontend.md` §3.2 | 드로잉 키 일부 | §4의 표로 바꾼다 | |
| `frontend.md` §3.5 흐름 | 도구 6개, 자석 켬/끔 | §2, §3. 자석 약·강 | |
| `frontend.md` §3.5 규칙 5 | "`logicalToCoordinate()`로 바꾼다" | §6.3의 직접 계산 | 라이브러리가 소수 index에 `0`을 돌려준다[P] |
| `frontend.md` §5.3 | `tool` 7개, `magnet: boolean`, `selectedDrawingId` | 21개, `magnet: boolean`에 `magnetStrength: "weak" \| "strong"`을 더함, `selectedDrawingIds: Uuid[]` | |
| `frontend.md` §5.3 `drawingHistory` | 한 칸 = `DrawingOp` | 한 칸 = `DrawingOp[]` | 여러 개를 한 번에 되돌린다 |
| `frontend.md` §5.7 드로잉 줄 | `zOrder: "top"` | `"normal"`, primitive 하나 | `top`은 십자선을 가린다[P] |
| `frontend.md` §5.1 폴더 | `DrawingPrimitive.ts, tools.ts` | §7.2의 파일 | |
| `backend.md` `drawings` 표와 계약 | §5.1 왼쪽 | §5.2 | |
| `backend.md` 오류 표 `payload_too_large` | 드로잉 없음 | 드로잉 PUT 본문 64KB | |
| `backend.md` `UiState` | | `drawing` 키 설명 | |

## 9. 위험

- **봉 주기를 바꾼 뒤의 끌기**: 60분봉에서 일봉 드로잉을 끌면 자석이 점을 60분봉 시작에 붙인다. 원래의 00:00이 사라진다. 의도한 동작이지만 사용자에게 놀랍다면 "끈 점만 바뀐다"를 e2e로 고정한다[설계].
- **체결 없는 틈에 놓인 점**: §3.5 규칙 2는 틈을 접어 다음 봉 시작에 그린다. 그 점을 끌지 않고 다른 점만 끌면 그 점의 `t`는 그대로다. 몸통을 끌면 모든 점을 새로 계산하므로 틈 안의 `t`가 다음 봉 시작으로 바뀐다. 1봉 이내의 차이다[설계].
- **같은 드로잉을 두 탭에서 고침**: 마지막 PUT이 이긴다. 되돌리기는 §3.11의 `updatedAt` 비교로 막는다. architect 승인 지점에서 확정한다.
- **4칸에 같은 종목**: 칸마다 `DrawingLayer`가 같은 캐시를 읽는다. 끄는 동안의 미리보기는 그 칸에만 있다. 다른 칸은 `pointerup` 뒤 캐시가 바뀌어야 따라온다[설계].
- **기본값의 출처**: 색·굵기는 Charting Library 값이다[§1]. 웹 앱과 다를 수 있다.
- **직접 관찰이 없다**: 핸들 위치, 점 찍는 방식, 막대 구성은 설계로 정했다. 사용자가 TradingView 계정으로 써 보고 다르다고 하면 엔진 PR 리뷰에서 고친다.
- **`Ctrl+Alt+H`**: 리눅스 데스크톱이 먼저 가져가는지는 확인하지 않았다[추정].

## 10. 열린 질문

### 10.1 사용자가 정할 것

| # | 질문 | 추천 | 다른 선택 |
|---|---|---|---|
| Q1 | 복제 수정키를 무엇으로 할까? | **`Ctrl`+끌기**. TradingView가 이 키다[E:S42, E:S4]. 이슈의 `Alt`는 TradingView를 따르려던 것으로 보인다 | `Alt`+끌기(이슈 #6 문구). 그러면 `Ctrl`은 자석과 여러 개 고르기만 맡아 뜻이 줄어든다 |
| Q2 | TradingView의 `Alt` 도구 단축키(`Alt+T`, `Alt+H`, `Alt+J`, `Alt+V`, `Alt+F`, `Shift+Alt+R`)를 별칭으로 받을까? | **받는다.** TradingView를 쓰던 손버릇이 그대로 듣는다. 기존 한 글자 키는 그대로 둔다 | 받지 않는다. 표가 짧다 |
| Q3 | 롱·숏 포지션의 목표·손절 색 | **목표 = 상승색(빨강), 손절 = 하락색(파랑)**. 앱의 다른 곳과 같다 | TradingView처럼 목표 초록, 손절 빨강 |
| Q4 | §3.13 "하지 않는 것"(복사·붙여넣기, 템플릿, 추세선 알림, 개체 그룹, 동기화 모드)을 빼도 될까? | **뺀다.** 이슈 #34 범위 밖이거나 이 앱의 설계(종목에 붙음)와 겹친다 | 필요한 것을 골라 #6 뒤 새 이슈로 |

### 10.2 엔진 일꾼이 정할 것

- 핸들 크기·판정 반경(§2.1 8px/6px)과 `Shift` 끌기의 방향 결정 거리(8px)는 손으로 써 보고 조정한다.
- 떠 있는 막대의 자리 규칙(드로잉 위, 칸 밖으로 나가면 아래).
- 오른쪽 클릭 메뉴의 "보이는 봉 주기" 빠른 선택 묶음.

## 11. ADR·용어 제안

용어집과 ADR은 고치지 않았다. PR 본문의 "ADR·용어 제안"과 같다.

- **용어**
  - **자석 모드**(고침 제안): "드로잉의 점을 가장 가까운 봉의 시가·고가·저가·종가에 붙이는 것. **약**은 화면 16px 안일 때만, **강**은 거리와 상관없이 붙인다."
  - **핸들**(새 용어 제안): 고른 드로잉에 보이는, 끌어서 점 하나를 옮기는 작은 원. _Avoid_: 손잡이, 앵커.
  - **개체 목록**(새 용어 제안): 활성 칸 종목의 드로잉을 그리는 순서대로 나열한 패널. _Avoid_: 오브젝트 트리.
  - **연속 그리기**(새 용어 제안): 다 그려도 도구가 남아 같은 도구로 계속 그리는 모드. _Avoid_: 드로잉 모드 유지.
- **ADR**: 없음. 드로잉이 종목에 붙는다는 결정은 ADR 0007에 있다. 이 제안은 그 안에서 화면 동작만 정한다.
