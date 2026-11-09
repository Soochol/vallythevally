# 백엔드 설계

vallythevally Rust 백엔드의 설계다. #2의 코드(`crates/domain`, `crates/server`)가 있다. 이 문서의 Rust 코드 블록은 형태를 보여 주는 스케치다. #2에서 켜진 절은 코드에 맞췄고, 아직 켜지지 않은 절은 설계다. 코드와 이 문서가 다르면 코드가 지금의 사실이다.

- 기준 문서
  - `GLOSSARY.md`, `docs/adr/0001`~`0007`
  - 이슈 #2~#9, #14(로드맵 #12)
  - `docs/kiwoom.md`(조회 실측 2026-11-08, 11~13절은 2026-11-09)
  - `docs/design/decisions-r1.md`(코디네이터 결정). 이 문서와 다르면 결정 문서를 따른다.
- 키움 동작 중 아직 재지 않은 것은 **[실측 대기]**로 표시했다. 장중에만 잴 수 있는 것은 **[장중 실측 대기]**로 표시했다. 기본값은 §12에 모았다.
- 브라우저 쪽이 기대는 것은 모두 §8 **브라우저 계약**에 있다. 프런트엔드는 §8만 읽으면 된다.

## 0. 단계별로 켜지는 기능

단계 번호는 이슈 번호다(decisions-r1 D3). 각 절 제목 아래에 그 절이 켜지는 단계를 적었다.

| 이슈 | 단계 | 켜지는 것 | 아직 없는 것 |
|---|---|---|---|
| #2 | 1단계 기반 | 1칸 고정, REST `/api/symbols`·`/api/bars`, 메모리 캐시(07:45 비우기), 종목 목록(메모리), 키움 조회 대기열, 잠금 파일, 차트 설정은 브라우저 메모리에 | WebSocket, WASM, DB |
| #14 | 1.5단계 거래소 | 칸마다 거래소(통합·KRX·NXT), `/api/bars`의 `venue`, `SymbolInfo.nxtEnabled`, 분봉(1·3·5·15·30·60분) 과거 조회. 분봉의 진행 중 구간은 조회 스냅숏 | WebSocket, 실시간 현재 봉 |
| #3 | 2단계 저장 | SQLite 파일 `data/vally.db`(sqlx 마이그레이션), 기본 레이아웃 마이그레이션, 관심종목, `UiState`, 자동 저장. 관심종목 현재가는 REST 조회 | WebSocket |
| #4 | 3단계 실시간 | WebSocket, 구독, 실시간 현재 봉 집계(일·주·월봉과 분봉), `seq` | |
| #5 | 4단계 지표 | WASM 지표, 비교 종목 | |
| #6~#9 | 5~8단계 | 드로잉 → 여러 칸 → 알림 → 클라우드 | |

- **#2의 진행 중 구간**(D3, D12): 실시간이 아직 없다. 그래서 REST 최신 페이지의 `current`로 진행 중 구간을 보여 준다. 이 값은 키움 조회가 준 오늘 봉(이번 주, 이번 달 봉)이다. 종목이나 봉 주기를 바꾸거나 새로고침할 때만 새로 받는다. `BarsPage.seq`는 `null`이다.
- **#2 완료 조건**(D14): 서버를 다시 켜도 차트가 몇 초 안에 다시 뜬다. 캐시는 비어 있으므로 키움에서 다시 받는다(일봉 1회 조회).
- **#14는 #3보다 먼저다**(D17): #3의 레이아웃 저장 형식이 처음부터 칸의 거래소를 담게 하려는 것이다. 표는 이슈 번호가 아니라 켜지는 순서로 놓았다. 분봉 과거 조회도 #4에서 이 단계로 당겼다. #4에 남는 것은 실시간 현재 봉이다.
- **#14의 진행 중 구간**: #2와 같다. 분봉도 최신 페이지의 `current`(키움 조회 스냅숏)로 보여 준다.
- **DB는 #3부터, SQLite 파일 하나**(D14, D15, ADR 0006): #2 서버는 DB 없이 뜬다. #3에서 사용자 자료용 SQLite 파일(`data/vally.db`, git 제외)을 처음 만든다. 따로 띄우는 DB 서버는 없다. 시세는 DB에 두지 않는다(ADR 0003).

---

## 1. 크레이트 구성과 의존 방향

> 켜지는 단계: #2(`indicators`는 #5)

### 결론

```
vallythevally/
├── Cargo.toml            # workspace
├── crates/
│   ├── domain/           # 순수. 체결·봉·봉 주기·종목코드·시각·현재 봉 집계·알림 판단
│   ├── indicators/       # 순수. 지표 종류 일곱 가지. feature "wasm"으로 브라우저용 빌드
│   └── server/           # 바이너리 하나. Axum + 키움 + 메모리 캐시 + 실시간 + 알림 + SQLite(#3부터, 사용자 자료만)
├── migrations/           # sqlx 마이그레이션(SQLite 사용자 자료, #3부터)
├── data/                 # vally.db (git 제외, #3부터)
└── web/                  # React (이 문서 범위 밖)
```

```
indicators ──▶ domain
server ──────▶ domain, indicators
web(WASM) ───▶ indicators(feature "wasm")
```

크레이트는 세 개다. 후보였던 `kiwoom`과 `store`는 크레이트로 만들지 않는다. `server` 안의 모듈로 둔다.

### 경계마다의 근거

| 경계 | 둔 이유 |
|---|---|
| `domain` 크레이트 | ADR 0003은 봉 집계와 알림 판단을 "체결 목록을 받는 순수 함수"로 만들라고 한다. 별도 크레이트로 두면 `Cargo.toml`에 tokio·sqlx·reqwest가 없다. 그래서 순수성을 **컴파일러가 강제**한다. 시계도 읽지 않는다. 현재 시각은 인자로 받는다. 호출자는 `server`와 `indicators` 둘이다. |
| `indicators` 크레이트 | 브라우저(WASM)와 서버(지표 알림)가 같은 코드를 쓴다(ADR 0002). WASM으로 빌드되어야 하므로 IO 의존이 없어야 한다. 호출자가 둘이다. |
| `indicators` → `domain` | 일목균형표 선행스팬은 마지막 봉 뒤의 미래 봉 시작 시각이 필요하다. 봉 경계 규칙의 유일한 정의는 `domain::Period`다. 그래서 브라우저도 같은 함수를 WASM으로 받는다(§9.3). |
| `domain`은 `indicators`를 모른다 | 지표 알림의 판단은 "지표 값 두 쌍이 교차했나"뿐이다. `domain::alert`는 `f64` 값만 받는다. 지표 계산은 `server`가 `indicators`로 해서 넘긴다. 그래서 순환이 없다. |
| `kiwoom`은 모듈 | 호출자는 `server` 하나다. 실측 프로그램(#1)은 버릴 코드라 두 번째 호출자로 치지 않는다. 크레이트로 나눠서 얻는 것은 파서 테스트의 빌드 격리 정도인데, 모듈 테스트로 충분하다. 시세 API만 쓰게 하는 장치(§4.4)는 타입과 테스트로 건다. |
| `store`는 모듈 | 호출자는 `server` 하나다. sqlx의 컴파일 시점 쿼리 검사는 크레이트를 나누지 않아도 된다. 시세 캐시가 메모리로 옮겨 가서(ADR 0003) `store`에는 사용자 자료(`store::app`, SQLite)만 남는다. #2에는 `store`도 sqlx 의존도 없다. #3에서 처음 들어온다. |

나중에 두 번째 바이너리가 같은 키움 클라이언트를 써야 하면 그때 `server::kiwoom`을 크레이트로 뺀다. ADR 0004 때문에 토큰을 가진 프로세스는 하나뿐이어야 하므로 그런 일은 드물 것이다.

### `server` 안의 모듈

깊은 모듈로 나눈다. 작은 인터페이스 뒤에 많은 일을 숨긴다. 바깥에 보이는 것은 각 모듈의 핸들 하나다.

| 모듈 | 바깥에 보이는 것 | 숨기는 것 | 단계 |
|---|---|---|---|
| `config` | `Config::from_env()` | `VALLY_ENV_FILE` 읽기, 검증, 비밀값 감싸기 | #2 |
| `instance` | `InstanceLock::acquire(path)` | 잠금 파일(`flock`)로 서버 하나 보장(§4.1) | #2 |
| `kiwoom::auth` | `KiwoomAuth`(토큰 단일 소유자) | 토큰 상태, 만료 판단, 다시 발급할지 정하는 규칙 | #2 |
| `kiwoom::rest` | `KiwoomRest::call(req, cont, priority, scope)`, `issue_token()` | 대기열, 초당 4회, au10001 보내기, 같은 요청 합치기, 연속조회, 오류 대응 | #2 |
| `kiwoom::api` | 요청 타입(`MarketRequest`), `kiwoom_stock_code` | 허용 목록, 경로, 종목코드 접미사 | #2 |
| `kiwoom::ws` | `KiwoomStream` | LOGIN, PING, REG/REMOVE, 재연결, 토큰 세대 변경 | #4 |
| `kiwoom::wire` | 응답 → `domain` 타입 파서 | 부호, 배율, 필드 번호, 빈 행, 날짜 형식, 시고저종 보정 | #2 |
| `bars` | `BarService` | 메모리 캐시, 캐시 구간, 시리즈 세대 번호, 키움 조회, 10분 내리기와 07:45 비우기 | #2(분봉 과거 조회는 #14) |
| `symbols` | `SymbolDirectory` | 메모리 종목 목록(켤 때와 07:45에 갱신), 검색 | #2 |
| `market` | `MarketHub`(액터) | 구독 관리자, 현재 봉 집계, 확정, `seq`, 끊긴 구간 복구, 브라우저로 내보내기 | #4 |
| `alert` | `AlertEngine` | 가격 알림·지표 알림 판단 실행, 반복, 기록 | #8 |
| `notify` | `Notifier::send(event)` | 텔레그램, 화면 안 알림 | #8 |
| `store::app` | 사용자 자료 저장소 | SQLite 연결 풀, 쓰기 연결 하나, sqlx 쿼리와 마이그레이션 | #3 |
| `http` | `router(state)` | REST, 브라우저 WebSocket, 정적 파일 | #2(WS는 #4) |

---

## 2. 핵심 타입과 불변식

> 켜지는 단계: #2

원칙은 잘못된 상태를 표현할 수 없게 하는 것이다. 외부 자료(키움 응답, 브라우저 JSON, DB 행)는 경계에서 한 번 파싱한다. 안쪽에서는 타입을 믿는다.

### 2.1 종목코드

종목과 거래소를 나눠 둔다(ADR 0007, D17). `Symbol`은 거래소와 무관한 단위다. 드로잉처럼 거래소와 상관없는 것이 여기에 붙는다. 차트가 그리는 시세는 `Feed`다. 주식은 거래소를 고르고, 지수에는 거래소가 없다. 지수에 거래소를 주는 상태는 `Feed`로 만들 수 없다.

```rust
/// KRX 단축코드 6자리. 영문 대문자가 섞일 수 있다(예: "0000D0", "03481K"). 끝자리도 글자일 수 있다.
#[derive(Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct StockCode([u8; 6]);

impl StockCode {
    pub fn parse(s: &str) -> Result<Self, SymbolError>; // [0-9A-Z]{6}만 허용
    pub fn as_str(&self) -> &str;
    /// 끝자리가 '0'이 아니면 우선주다(kiwoom.md §5). 주식 집합 안에서만 쓴다.
    pub fn is_preferred_code(&self) -> bool;
}

/// 키움 업종코드 3자리. 코스피 "001", 코스닥 "101".
#[derive(Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct IndexCode([u8; 3]);

/// 종목 또는 지수. 거래소와 무관한 단위다. 차트로 그리는 시세는 Feed다.
#[derive(Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Symbol {
    /// 주식(보통주·우선주·리츠)과 ETF.
    Stock(StockCode),
    Index(IndexCode),
}

impl Symbol {
    /// 브라우저와 DB에서 쓰는 문자열. 주식 "005930", 지수 "IDX:001".
    pub fn parse(s: &str) -> Result<Self, SymbolError>;
    pub fn as_wire(&self) -> String;
}

/// 시세가 체결된 곳(용어집 "거래소"). 칸마다 하나를 고르고 기본은 통합이다. 지수에는 없다.
#[derive(Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Default)]
pub enum Venue {
    /// KRX와 NXT를 합친 통합 시세.
    #[default]
    Combined,
    Krx,
    Nxt,
}

impl Venue {
    pub const ALL: [Venue; 3];
    pub fn as_wire(self) -> &'static str;          // "combined" "krx" "nxt"
    pub fn parse(s: &str) -> Option<Self>;         // 이 세 값만. "KRX"는 None
}

/// 차트가 그리는 시세 하나.
#[derive(Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Feed {
    Stock(StockCode, Venue),
    Index(IndexCode),
}

impl Feed {
    /// 지수에 거래소를 주면 None. 주식에 거래소를 주지 않으면 통합이다.
    pub fn new(symbol: Symbol, venue: Option<Venue>) -> Option<Feed>;
    pub fn symbol(self) -> Symbol;
    pub fn venue(self) -> Option<Venue>;           // 지수면 None
}
```

키움에 보낼 코드는 `domain`에 두지 않는다. 거래소 접미사는 `server::kiwoom::api`의 함수 하나가 만든다. 키움 종목코드를 만드는 곳은 거기뿐이다(kiwoom.md 3·12·13절).

```rust
// server::kiwoom::api
pub fn kiwoom_stock_code(code: StockCode, venue: Venue) -> String;
// Combined → "005930_AL", Krx → "005930", Nxt → "005930_NX"
```

- 지수는 거래소 구분이 없다. ka20005~ka20008의 `inds_cd`는 업종코드 3자리 그대로다(kiwoom.md 12.4).
- NXT 이력은 2025-03부터다. 그 전 구간은 `_NX`로 받으면 봉이 없다. `_AL`은 NXT 이전 구간을 KRX 값으로 채운다.
- NXT에서 거래되지 않는 종목(`nxt_enabled = false`, 주식의 약 78%)은 통합과 KRX가 같다(kiwoom.md 12.4).

종목 정보(목록·검색용)는 따로 둔다.

```rust
/// 검색에서 같은 순위일 때 이 순서로 앞에 둔다(D5): Index > Common > Preferred > Etf > Reit.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum SymbolKind { Index, Common, Preferred, Etf, Reit }
pub enum Market { Kospi, Kosdaq }

pub struct SymbolInfo {
    pub symbol: Symbol,
    pub name: String,
    pub kind: SymbolKind,
    pub market: Market,
    /// NXT에서 거래되는 종목인가(ka10099 nxtEnable == "Y"). 지수는 언제나 false.
    pub nxt_enabled: bool,
}
// 검색용 초성열은 server::symbols의 목록 안에 따로 둔다. 목록을 받을 때 만든다.
```

### 2.2 가격과 수량

체결과 봉에 `f64`를 넣지 않는다. 주식 가격은 원 단위 정수이고 지수는 소수 둘째 자리까지다. 둘을 한 타입으로 받으려고 **0.01 단위 정수**로 둔다. 주식 가격은 언제나 100의 배수가 된다. TR마다 배율이 달라서 변환은 파서의 단위 표(§4.6)가 맡는다.

```rust
/// 0.01 단위 가격. 0보다 크다.
/// 주식 193,500원 → Price(19_350_000). 코스피 5,059.69 → Price(505_969).
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Price(NonZeroU64);

impl Price {
    pub fn from_centi(v: u64) -> Option<Self>;
    pub fn centi(self) -> u64;
    pub fn to_f64(self) -> f64; // 지표 계산과 브라우저 전송에만 쓴다(자연 단위로)
}

/// 체결 수량 또는 봉 거래량. 부호가 없다.
/// 0B의 체결량은 매수/매도를 부호로 나타내지만 파서에서 절댓값으로 바꾼다.
/// 지수의 거래량 단위는 아직 모른다(§4.6). 받은 값을 그대로 담는다.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Default)]
pub struct Volume(u64);
```

거래대금은 봉에 담지 않는다. 키움 거래대금 단위는 TR마다 다르다(일봉 백만원, 주·월봉 원). 차트 화면에 필요가 없어서 v1에서는 파싱하지 않는다.

### 2.3 시각

KST는 1988년 이후 서머타임이 없다. 그래서 고정 오프셋(+09:00)으로 충분하고 시간대 데이터베이스가 필요 없다.

```rust
/// 한 순간. 내부 표현은 Unix 초(UTC 기준). 사람에게 보이거나 경계를 계산할 때만 KST로 바꾼다.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct KstTime(i64);

impl KstTime {
    pub fn from_unix(secs: i64) -> Self;
    pub fn from_kst_civil(date: KstDate, tod: TimeOfDay) -> Self;
    pub fn kst_date(self) -> KstDate;
    pub fn kst_time_of_day(self) -> TimeOfDay;
    pub fn unix(self) -> i64;
}

pub struct KstDate { /* y, m, d — 유효한 날짜만 */ }
/// 00:00:00 ~ 23:59:59.
pub struct TimeOfDay(u32 /* 하루 안의 초 */);
```

### 2.4 봉 주기와 봉 구간

```rust
#[derive(Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Period { M1, M3, M5, M15, M30, M60, Day, Week, Month }

impl Period {
    pub const ALL: [Period; 9];
    pub fn as_wire(self) -> &'static str;          // "1m" "3m" "5m" "15m" "30m" "60m" "D" "W" "M"
    pub fn parse(s: &str) -> Result<Self, PeriodError>;
    pub fn is_intraday(self) -> bool;               // 분봉이면 true

    /// 시각 t가 속한 봉 구간. 봉 시작 시각을 만드는 유일한 방법이다.
    pub fn bucket(self, t: KstTime) -> Bucket;
}

/// (봉 주기, 봉 시작 시각). 시작 시각이 봉 주기의 경계에 맞는다는 것이 불변식이다.
/// 필드가 비공개라 Period::bucket과 Bucket::next/prev로만 만든다.
#[derive(Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct Bucket { period: Period, start: KstTime }

impl Bucket {
    pub fn period(self) -> Period;
    pub fn start(self) -> KstTime;
    /// 구간이 끝나는 시각(배타). 분봉은 start + n분.
    pub fn end(self) -> KstTime;
    /// 이 봉이 확정되는 시각(§3.3). 현재 봉 확정은 이것 하나로 판단한다.
    pub fn confirm_at(self) -> KstTime;
    pub fn is_confirmed_at(self, now: KstTime) -> bool { self.confirm_at() <= now }
    pub fn next(self) -> Bucket;
    pub fn prev(self) -> Bucket;
    pub fn contains(self, t: KstTime) -> bool;
}
```

### 2.5 체결

```rust
/// 거래가 한 번 성립한 것. 시각은 날짜까지 정해진 KST 순간이다.
pub struct Trade {
    pub at: KstTime,
    pub price: Price,
    pub qty: Volume,
    /// 0B 누적거래량(필드 13). 조회로 받은 시드와의 경계를 판단하는 데 쓴다(§5.4).
    /// 0J처럼 없거나 믿을 수 없으면 None.
    pub day_cum: Option<Volume>,
}
```

0B에는 체결시간(HHMMSS)만 있고 날짜가 없다. `Trade`는 날짜가 정해진 뒤에만 만들 수 있다(§3.1의 `resolve_trade_time`).

### 2.6 봉, 확정 봉, 현재 봉, 봉 출처

```rust
/// 시가·고가·저가·종가·거래량. 불변식: low ≤ open, close ≤ high.
pub struct Ohlcv { open: Price, high: Price, low: Price, close: Price, volume: Volume }

impl Ohlcv {
    /// 키움 응답처럼 바깥에서 온 값. 불변식을 검사한다.
    pub fn try_new(o: Price, h: Price, l: Price, c: Price, v: Volume) -> Result<Self, OhlcvError>;
    /// 체결 하나로 시작하는 봉.
    pub fn from_trade(t: &Trade) -> Self;
    /// 체결을 더한다. 불변식이 저절로 유지된다.
    pub fn absorb(&mut self, t: &Trade);
    pub fn open(&self) -> Price; /* high, low, close, volume 도 같은 꼴 */
}

/// 봉 출처. 직렬화 이름은 "realtime", "kiwoom"이다(브라우저 계약 AlertEvent.barSource와 같다).
#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum BarSource {
    /// 실시간으로 만든 봉. 서버가 체결을 모아 확정한 것. 같은 구간을 키움에서 받으면 교체된다.
    Realtime,
    /// 키움에서 조회한 봉.
    Kiwoom,
}

/// 확정 봉. 캐시에 들어갈 수 있는 유일한 봉 타입이다.
pub struct ConfirmedBar {
    pub bucket: Bucket,
    pub ohlcv: Ohlcv,
    pub source: BarSource,
    /// Realtime 이면서, 시드 경계를 몰라 체결이 빠졌거나 겹쳤을 수 있는 봉(§5.4).
    /// 확정 즉시 키움 값으로 교체를 예약하고, 교체될 때까지 지표 알림을 판단하지 않는다.
    pub needs_verify: bool,
}

/// 현재 봉. 봉 출처 필드가 없다(언제나 서버가 체결로 만든다).
/// 캐시 저장 함수는 ConfirmedBar만 받는다. 그래서 현재 봉은 타입 수준에서 캐시에 들어갈 수 없다(ADR 0003).
pub struct CurrentBar {
    bucket: Bucket,
    ohlcv: Ohlcv,
    boundary: SeedBoundary,
}

/// 키움 조회값으로 시작한 현재 봉에서, 어디까지의 체결이 이미 들어 있는가.
pub enum SeedBoundary {
    /// 체결 하나로 시작했다. 빠진 체결이 없다.
    FromTrade,
    /// 조회 응답의 당일 누적거래량. 이 값 이하의 day_cum을 단 체결은 이미 들어 있다.
    DayCum(Volume),
    /// 경계를 모른다. 이 봉은 불완전하다.
    Unknown,
}
```

브라우저로 보낼 때 확정 봉과 현재 봉은 같은 JSON 모양(§8의 `Bar`)이다. 메시지 종류로 둘을 구분한다.

### 2.7 캐시 키

```rust
/// 캐시 키: (종목, 거래소, 봉 주기). 지수에는 거래소가 없다(ADR 0007).
#[derive(Clone, Copy, PartialEq, Eq, Hash)]
pub struct SeriesKey { pub feed: Feed, pub period: Period }
```

- 같은 종목도 거래소가 다르면 다른 시리즈다. `005930` 통합 일봉과 KRX 일봉은 따로 받고 따로 캐시한다.

---

## 3. 시간 모델

> 켜지는 단계: #2(봉 경계와 `confirm_at`. 분봉 경계도 `Period::bucket`에 있다), #14(분봉 조회에 씀), #4(체결 날짜, 확정 타이머)

### 3.1 0B 체결시간에 날짜 정하기

체결 시간은 평일 **[08:00, 20:00)** 이다. 다만 20:00:00~20:00:03의 체결도 0B로 온다. 키움 REST는 이 체결을 19:59 봉에 넣는다(D16, kiwoom.md 11.8). 자정을 넘는 체결은 없다. 그래서 **수신 시각의 KST 날짜**를 붙이면 된다. 시계가 어긋난 경우를 걸러 내려고 검사를 둔다.

```rust
pub const TRADING_OPEN: TimeOfDay;  // 08:00:00 (포함)
/// domain::SESSION_CLOSE. 20:00:00. 장 끝에 닿는 봉의 끝이다.
pub const SESSION_CLOSE: TimeOfDay;
/// domain::CLOSE_GRACE_SECS = 10. [SESSION_CLOSE, SESSION_CLOSE + 10초)의 체결은 받는다.
pub const CLOSE_GRACE_SECS: i64;

pub enum TradeTimeError {
    /// [08:00:00, 20:00:10) 밖.
    OutsideTradingWindow,
    /// 체결시간이 수신 시각보다 60초 넘게 미래. 서버 시계가 늦다.
    FromFuture,
    /// 체결시간이 수신 시각보다 5분 넘게 과거. 밀린 메시지이거나 시계가 빠르다.
    TooOld,
}

/// received_at: 서버가 메시지를 받은 시각(호출자가 시계를 읽어 넘긴다).
pub fn resolve_trade_time(received_at: KstTime, hhmmss: TimeOfDay) -> Result<KstTime, TradeTimeError>;
```

- 규칙: `t = 수신 시각의 KST 날짜 + hhmmss`. `t`가 위 세 검사를 통과해야 `Trade`가 된다.
- **장 끝의 체결**(#4): `[20:00:00, 20:00:10)`의 체결은 그날 마지막 분 구간의 체결로 집계한다. 1분봉이면 19:59 봉, 5분봉이면 19:55 봉이다. `Period::bucket`은 시계로만 자르므로 20:00:03을 20:00 구간에 넣는다. 그래서 집계 함수가 이 체결의 시각을 19:59:59로 당겨서 넣는다. 일·주·월봉은 원래 그날 구간이라 따로 할 일이 없다.
- 이 체결을 받으려면 실시간 연결을 20:00:10 뒤까지 유지한다(§5.2).
- 걸러진 체결은 버린다. 종류별 카운터와 `warn` 로그를 남긴다. 현재 봉에는 영향을 주지 않는다. 그 구간의 확정 봉은 나중에 키움 조회로 바로잡힌다.
- 공휴일인지는 따지지 않는다. 체결이 오면 받는다.

키움 차트 조회 응답은 날짜가 들어 있으므로 추론하지 않는다. 분봉 `cntr_tm`은 `YYYYMMDDHHMMSS`이고 일·주·월봉 `dt`는 `YYYYMMDD`이다.

### 3.2 봉 경계

모든 경계는 KST 기준이다.

| 봉 주기 | 봉 시작 시각 | 끝(배타) |
|---|---|---|
| 1·3·5·15·30·60분 | KST 자정부터 n분 단위로 자른 경계(예: 5분봉 09:05, 09:10) | 시작 + n분 |
| 일 | 그 날짜 00:00 KST | 다음 날 00:00 |
| 주 | 그 주 월요일 00:00 KST | 다음 주 월요일 00:00 |
| 월 | 그 달 1일 00:00 KST(1일이 주말이어도) | 다음 달 1일 00:00 |

- **08:00 기준이냐 09:00 기준이냐**: 우리 봉 주기(1·3·5·15·30·60분)는 모두 60분의 약수다. 그래서 08:00에서 자르든 09:00에서 자르든 정시에서 자르든 경계가 같다. 실측도 이와 맞는다. `_AL` 60분봉이 08:00~19:00 정시로 붙는다(kiwoom.md §1).
- 키움 분봉 `cntr_tm`은 **구간 시작 시각**이다.
- 주봉·월봉 `dt`는 구간의 **첫 관측일**이다. 달력의 첫날이 아니다. 예를 들어 이번 주 봉과 2026-11 월봉이 둘 다 `20261102`로, 2025-03 월봉이 `20250304`로 왔다(kiwoom.md §10.4·10.5). 그래서 주봉은 그 주 월요일로, 월봉은 그달 1일로 **반드시** 맞춘다.
- 파서는 키움이 준 시각을 `Period::bucket`에 넣어 다시 맞춘다. 분봉은 결과가 키움 값과 다르면 파싱 오류로 본다. 주봉·월봉은 결과(월요일, 1일)를 그대로 쓴다.
- 체결이 없는 분은 봉을 만들지 않는다. 빈 봉을 채우지 않는다. 키움도 08:50~08:59, 15:20~15:29처럼 체결이 없는 분은 건너뛴다(kiwoom.md §2).
- 개장이 늦은 날(예: 10:00 개장)도 같은 규칙으로 처리된다. 경계는 시계만으로 정해지고 장 시간표를 쓰지 않는다.

### 3.3 봉 확정

현재 봉은 다음 두 경우 중 **먼저 오는 쪽**에서 확정된다.

1. 이 구간보다 늦은 구간의 체결이 들어온다.
2. 서버의 1초 타이머가 `now ≥ confirm_at`을 본다.

확정된 구간의 체결시간을 단 체결이 그 뒤에 오면 **늦은 체결**이다. 현재 봉에 넣지 않고 카운터만 올린다. 확정 봉은 나중에 키움 값으로 교체된다. 유예 동안 이전 구간과 새 구간을 둘 다 열어 두는 방식은 쓰지 않는다. 열린 봉이 언제나 하나여야 집계 함수가 단순하다.

| 봉 주기 | `confirm_at` |
|---|---|
| 분봉(장 중간) | 구간 끝 + 2초(`MINUTE_GRACE_SECS`) |
| 분봉(구간 끝이 20:00) | 그날 20:00:00 + 10초(`CLOSE_GRACE_SECS`) |
| 일 | 그날 20:00:00 + 10초 |
| 주 | 그 주 금요일 20:00:00 + 10초 |
| 월 | 그 달 마지막 평일 20:00:00 + 10초 |

- 2초는 장 중간에 늦게 도착하는 체결을 기다리는 유예다.
- 장 끝에 닿는 봉은 10초를 기다린다. 20:00:00~20:00:03 체결이 그 봉에 들어가기 때문이다(D16). 2초로는 20:00:03 체결을 놓친다. 코드의 `Bucket::confirm_at`이 이 표다.
- 주말에는 체결이 없다. 그래서 "금요일 20:00"은 휴장일 달력 없이도 맞다. 금요일이 공휴일이면 그 주의 마지막 체결은 이미 들어와 있으므로 같은 시각에 확정해도 결과가 같다.
- 일봉 종가는 그날 마지막 봉(19:59)의 종가다(kiwoom.md §3). 그래서 일봉은 20:00 뒤에야 확정된다.
- #2에는 실시간이 없다. 그래도 같은 `confirm_at`으로 키움 조회의 마지막 행이 확정 봉인지 진행 중 구간인지 가른다(§6.3).

### 3.4 강제 단절 시각

키움은 매일 07:50(일요일 05:00)에 WebSocket을 끊는다(#4). 07:50은 체결이 없는 시간이라 현재 봉에는 영향이 없다. 다시 연결하는 절차는 일반 단절과 같다(§5.2). 끊길 때의 Close 코드와 다시 접속되는 시각은 [장중 실측 대기]다.

---

## 4. 키움 클라이언트 (ADR 0004)

> 켜지는 단계: #2(REST), #4(WebSocket)

### 4.1 토큰

토큰은 `KiwoomAuth` 하나가 가진다. `KiwoomAuth`는 토큰 상태와 규칙만 갖고 요청을 보내지 않는다. au10001은 조회 대기열(§4.2)이 직접 보낸다. 그래서 `KiwoomAuth::get()` 같은 "토큰을 받아 오는 함수"는 없다.

```rust
pub struct KiwoomAuth { /* app_key, app_secret: Secret, Mutex<State> */ }

struct State {
    issued: Option<Issued>,    // { token: Secret<String>, issued_at, expires_at, generation }
    stale: bool,               // 토큰 무효 응답을 받아 다시 발급해야 한다
    last_invalidate: Option<KstTime>,
    halted: Option<u16>,       // 되돌릴 수 없는 인증 실패의 상세 코드
}

/// 토큰이 다시 발급될 때마다 1씩 는다.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct TokenGen(pub u64);

impl KiwoomAuth {
    /// 지금 보낼 때 쓸 토큰. 무효로 표시됐거나, 멈췄거나, 만료까지 10분이 안 남았으면 None.
    pub fn current(&self, now: KstTime) -> Option<(Secret<String>, TokenGen)>;
    pub fn needs_issue(&self, now: KstTime) -> bool;
    /// au10001 본문. 앱키와 시크릿이 들어 있으므로 Secret으로만 낸다.
    pub fn issue_body(&self) -> Secret<String>;
    pub fn record_issued(&self, resp: TokenResponse, now: KstTime) -> Result<TokenGen, AuthError>;
    /// 토큰 무효 응답을 받았을 때만 부른다. seen이 지금 세대일 때만 다시 발급하도록 표시한다.
    /// 5분 안에 두 번째로 부르면 InvalidAgain.
    pub fn invalidate(&self, seen: TokenGen, now: KstTime) -> Result<(), AuthError>;
    /// 매일 20:05: 지금 토큰이 그날 20:05 전에 발급된 것인가.
    pub fn due_daily_reissue(&self, now: KstTime) -> bool;
    pub fn halt(&self, detail: u16);
}

impl KiwoomRest {
    /// au10001을 대기열 맨 앞에 넣고 결과를 기다린다. 서버를 켤 때와 20:05에만 부른다.
    pub async fn issue_token(&self) -> Result<TokenGen, KiwoomError>;
}
```

- **키는 하나**: 실계좌 키 하나만 쓴다(`VALLY_KIWOOM_APP_KEY`, `VALLY_KIWOOM_APP_SECRET`). 모의 키 설정은 없다.
- **발급하는 때**(ADR 0004): 발급을 되풀이하지 않는다.
  1. 서버를 켤 때 한 번. 토큰은 메모리에만 있으므로 피할 수 없다. 이 발급이 실패해도 서버는 뜬다. 다음 조회가 들어오면 대기열이 발급부터 다시 한다.
  2. 하루 한 번, 장이 끝난 뒤. 매일 20:05에, 지금 토큰이 그날 20:05 전에 발급된 것이면 다시 발급한다. 토큰은 24시간 유효하므로 만료가 장중에 오지 않는다. 20:05에 실패하면 07:45까지 10분마다 다시 시도한다.
  3. 토큰 무효 응답(`[8005]`)을 받았을 때. 그 요청은 `invalidate`를 한 번 부르고 한 번 다시 보낸다. 다시 보낼 때 대기열이 먼저 발급한다. 그래도 `[8005]`면 그 요청은 `AuthFailed`다. 5분 안에 두 번은 발급하지 않는다.
  4. 안전장치: 만료까지 10분이 안 남으면 `current`가 `None`을 주고, 대기열이 다음 요청 전에 발급한다.
- **토큰은 보내는 순간에 읽는다**(D16): 대기 중인 요청은 토큰을 쥐고 있지 않다. 대기열이 요청을 내보낼 때 `current`로 읽는다. 그래서 새 토큰은 그 뒤의 모든 REST 요청에 바로 쓰인다. 옛 토큰으로 보낸 REST는 `[8005]`로 실패하기 때문이다(kiwoom.md 11.10).
- **au10001이 실패하면**: 기다리던 시세 요청을 모두 실패로 돌려준다. 토큰 없이는 어느 요청도 보낼 수 없다.
- **토큰과 WebSocket**(#4, D16)
  - 새 토큰을 받아도 기존 WebSocket 세션은 끊기지 않는다(kiwoom.md 11.10). 그래서 세대가 바뀌어도 세션을 일부러 닫지 않는다. 다음에 다시 연결할 때 그때의 토큰으로 LOGIN한다.
  - 같은 앱키로 두 번째 LOGIN을 하면 기존 세션이 close 1000 'Bye'로 끊긴다. 그래서 서버 하나 원칙(ADR 0004, 아래 잠금 파일)을 지킨다.
- **토큰은 메모리에만 둔다**: 서버를 다시 켜면 새로 발급한다. 재시작은 드물어서 받아들인다.
- 토큰 폐기(au10002)는 허용 목록에 넣지 않는다. 폐기할 일이 없다.

**켜는 순서**(`app.rs`): 설정 → 잠금 파일 → 사용자 자료 DB 열기(§7.1, 실패하면 종료 코드 1) → 포트 열기 → 첫 토큰 발급 → 종목 목록 받기를 태스크로 띄움 → 요청 받기. 목록이 오기 전에 요청을 받아야 "목록을 최대 10초 기다림"(§6.6)이 성립한다.

#### 토큰을 가진 프로세스는 하나: 잠금 파일

서버는 잠금 파일(`flock`)을 잡아 같은 PC에서 하나만 뜬다(ADR 0004). DB(#3부터 SQLite)로는 이 일을 하지 않는다.

```rust
/// 프로세스 수명 동안 쥐고 있는다. drop하거나 프로세스가 죽으면 OS가 잠금을 푼다.
pub struct InstanceLock { file: std::fs::File }

impl InstanceLock {
    /// flock(LOCK_EX | LOCK_NB). 이미 잡혀 있으면 기다리지 않고 바로 실패한다.
    pub fn acquire(path: &Path) -> Result<InstanceLock, LockError>;
}

pub enum LockError {
    /// 다른 프로세스가 잡고 있다. 파일에 적힌 pid를 함께 돌려준다(읽을 수 있으면).
    Held { pid: Option<u32> },
    /// 디렉터리나 파일을 만들 수 없다.
    Io(std::io::Error),
}
```

- **경로**: `VALLY_LOCK_PATH`(§11.1). 기본은 `$XDG_RUNTIME_DIR/vallythevally/server.lock`이다. `XDG_RUNTIME_DIR`이 없으면 `/tmp/vallythevally-<uid>/server.lock`이다. 디렉터리가 없으면 권한 `0700`으로 만든다.
- **순서**: 설정을 읽은 직후, 토큰 발급과 포트 열기보다 **먼저** 잡는다. 그래야 두 번째 서버가 토큰을 받아 첫 서버의 실시간 연결을 끊는 일이 없다.
- **잡은 뒤**: 파일 내용을 지우고 자기 pid를 적는다. 사람이 누가 잡고 있는지 보는 용도일 뿐이다. 잠금 여부는 pid가 아니라 `flock`으로만 판단한다.
- **못 잡으면**: `error` 로그에 "다른 서버가 이미 실행 중이다(pid N, 잠금 파일 경로)"를 남기고 종료 코드 1로 바로 끝낸다. 기다리거나 다시 시도하지 않는다. 키움에는 아무 요청도 보내지 않는다.
- **파일을 만들 수 없으면**(권한 등): 같은 방식으로 종료 코드 1. 잠금 없이 뜨지 않는다.
- **끝날 때**: 파일을 지우지 않는다. 지우면 그 사이에 다른 프로세스가 새 파일을 잡는 경합이 생긴다. 잠금은 프로세스가 죽으면 OS가 풀므로 남은 파일이 다음 실행을 막지 않는다.
- **이 잠금이 막지 못하는 것**
  - 실측 프로그램은 같은 잠금 파일을 잡고 돌린다(ADR 0004). kiwoom.md 12·13절의 조회는 `flock -n /run/user/1000/vallythevally/server.lock`으로 잡았다. 실측 프로그램이 잠금을 잡지 않고 돌면 이 장치로는 막지 못한다.
  - 로컬 서버와 클라우드 서버(#9)는 다른 PC라 막지 못한다. #9에서 옮길 때의 절차는 이렇다. 로컬 서버를 멈춘다 → 멈췄는지 확인한다 → 클라우드 서버를 켠다. 이 절차를 #9 문서에 적는다.

### 4.2 조회 대기열

```rust
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Priority {
    /// 브라우저가 기다리는 요청: 봉 페이지, 종목 하나 조회, 서버를 켤 때의 종목 목록.
    Screen,
    /// 끊긴 구간 복구, 불완전한 봉의 교체, 07:45 비우기 뒤 구독 중인 키 다시 채우기(§5.2, §5.4, §6.2).
    Recovery,
    /// 관심종목 현재가 1분 조회, 07:45 종목 목록 갱신, 20:05 정리 조회.
    Background,
}

pub struct KiwoomRest { /* KiwoomAuth, 대기열 셋, 진행 중 요청 표, 보내는 태스크 하나 */ }

impl KiwoomRest {
    /// 한 페이지를 받는다. 연속조회 키가 있으면 다음 페이지를 이어 받는다.
    pub async fn call<R: MarketRequest>(&self, req: &R, cont: Option<&ContKey>, priority: Priority, scope: MergeScope)
        -> Result<Page<R::Response>, KiwoomError>;
}

pub struct Page<T> { pub body: T, pub next: Option<ContKey> }
/// 응답 헤더가 cont-yn=Y 일 때의 next-key. N이면 None.
pub struct ContKey(String);
/// 같은 요청 합치기의 범위. BarService가 07:45 비우기마다 바꾼다.
pub struct MergeScope(pub u64);
```

- **속도: 초당 4회**(ADR 0003)
  - 서버 전체의 키움 조회를 대기열 하나가 내보낸다.
  - 요청을 내보내는 시각 사이를 최소 260ms 띄운다. 그러면 어느 1초 구간(양 끝 포함)에도 4회를 넘지 않는다.
  - 토큰 발급(au10001), 다시 보내기, 연속조회 페이지가 모두 이 제한에 든다.
  - 키움 한도는 초당 5회이지만 실측하지 않았다(kiwoom.md §9). 그래서 여유를 둔다.
- **토큰 발급과 대기열**: au10001은 대기열의 보내는 태스크가 직접 보낸다. 260ms 간격을 따르고, 다른 요청보다 먼저 나간다. 발급을 기다리는 호출(`issue_token`)이 있거나, 시세 요청이 있는데 `needs_issue`가 참이면 발급한다. 시세 요청은 내보내는 순간 `current`로 토큰을 읽는다(§4.1).
- **우선순위**
  - 기본은 `Screen` > `Recovery` > `Background` 순서다.
  - `Background`는 앞의 둘이 비었을 때만 나간다.
  - #4: `Recovery`가 기다리고 있으면 내보내는 4번 중 1번은 `Recovery`에 준다. 사용자가 과거로 계속 스크롤해도 복구가 멈추지 않는다. #2에는 `Recovery` 요청이 없어서 이 몫을 넣지 않았다.
  - #2·#14의 봉 조회는 모두 `Screen`이다. `BarService::page`는 우선순위를 받지 않는다.
- **같은 요청은 한 번만**
  - 진행 중 요청 표의 키는 `(합치기 범위, api-id, 정규화한 요청 본문, 연속조회 키)`다. 합치기 범위(`MergeScope`)는 `BarService`가 07:45 비우기마다 바꾼다. 비운 뒤의 조회가 비우기 전에 출발한 조회의 응답을 나눠 받으면 버린 옛 가격이 새 캐시에 들어가기 때문이다(§6.4).
  - 같은 키가 대기열에 있거나 응답을 기다리는 중이면 새로 넣지 않는다. 같은 결과를 나눠 받는다(`futures::future::Shared`).
  - 이미 들어간 요청보다 높은 우선순위로 같은 요청이 오면 그 요청의 우선순위를 올린다.
  - 합쳐진 결과를 받은 호출자는 **자기가 필요한 범위가 채워졌는지 다시 확인한다**. 모자라면 자기 요청을 이어서 낸다. `BarService`의 키별 합치기(§6.3)도 같다.
- **연속조회**: 한 페이지가 대기열의 한 칸이다. 다음 페이지를 이어 받을지는 호출자(`bars`)가 정한다. 이어지는 페이지는 앞 페이지의 우선순위를 물려받는다. 마지막 페이지는 `cont-yn: N`이고 `next-key`가 비어 있다. 남은 봉만 담긴 짧은 페이지로 끝난다(kiwoom.md §2).

### 4.3 응답 판정과 오류 대응

키움 응답은 세 겹으로 판정한다. 실측 결과(kiwoom.md §9)를 따른다.

0. **인증 거절 상세 코드**: `return_msg`에 8001~8200 중 8005 밖의 상세 코드가 있으면 HTTP 상태와 상관없이 먼저 멈춘다(아래 표). 8050이 HTTP 200으로 오는지 4xx/5xx로 오는지 아직 재지 못했다. 4xx/5xx를 전송 오류로 넘기면 조회마다 토큰을 다시 발급해 계정이 잠긴다(가짜 키움에서 HTTP 403 + `[8050]`이면 11초에 8번 발급했다).
1. **HTTP 상태**: 200이 아니면 전송 오류, 요청 개수 초과(429), 서버 오류(5xx)다. 토큰 무효는 HTTP 200으로 온다.
2. **최상위 `return_code`**: 0이면 성공이다. 0이 아니면 실패다. 이 숫자는 키움 오류 코드가 아니라 오류의 큰 갈래다. 관측한 값은 2(입력 값 오류), 3(인증 실패), 5(요청 개수 초과 갈래)다. **같은 5에 1700과 1634가 함께 오므로** 대응은 상세 코드로 가른다.
3. **`return_msg` 안의 상세 코드**: 키움 오류 코드는 메시지 속 대괄호에 들어 있다. 예: `"입력 값 오류입니다[1511:필수 입력 값에 값이 존재하지 않습니다. …]"`. 파서는 정규식 `\[(\d{4}):`로 꺼낸다. 없으면 `None`이다.

성공 응답이어도 한 번 더 검사한다.

4. **빈 행**: 없는 종목코드·지수코드는 성공 응답(`return_code: 0`)에 모든 필드가 `""`인 행 하나로 온다. 첫 행의 `dt`(일·주·월봉)나 `cntr_tm`(분봉)이 빈 문자열이면 `UnknownSymbol`로 바꾼다. 정상 응답에는 빈 행이 없었다.
   - NXT에서 거래되지 않는 종목의 `_NX` 요청도 같은 빈 행을 준다(kiwoom.md 12.4, 13절). 응답만으로는 "없는 종목"과 구별할 수 없다. 그래서 `BarService`는 `nxt_enabled = false`인 종목의 `Venue::Nxt` 요청을 키움에 보내기 전에 `BadRequest`로 거절한다(§8.2, #14).

```rust
pub struct KiwoomStatus {
    pub http: u16,
    pub return_code: i64,        // 최상위
    pub detail: Option<u16>,     // return_msg 안 [NNNN:
}

pub enum KiwoomError {
    RateLimited,
    AuthFailed { detail: Option<u16> },
    BadRequest { detail: Option<u16>, msg: String },
    UnknownSymbol,
    Transport(String),   // URL과 헤더를 뺀 설명
    Parse { api_id: ApiId, detail: String },
}
```

| 상황 | 판정 근거 | 대응 |
|---|---|---|
| 요청 개수 초과 | HTTP 429, `return_code: 5`, 상세 코드 1700(`유량=5`가 메시지에 있다). 판정은 HTTP 429 또는 상세 1700 | 같은 요청을 그 대기열 맨 앞에 다시 넣는다. 대기열 전체를 1초 멈춘다. 같은 요청이 3번 연속 걸리면 실패로 돌려준다. 260ms 간격이 모자랐다는 뜻이므로 `warn` 로그를 남긴다. |
| 토큰 무효·만료 | **HTTP 200**, `return_code: 3`, 상세 코드 8005. 판정은 상세 8005. 만료된 진짜 토큰도 같은 형태인지는 [실측 대기] | `invalidate` 한 번, 그다음 같은 요청을 한 번 다시 보낸다. 그래도 실패하면 `AuthFailed`. |
| 앱키·IP·투자구분 인증 실패 | 상세 코드 8001~8200 중 8005 밖. HTTP 상태는 보지 않는다 | 되돌릴 수 없는 설정 문제다. 모든 조회와 실시간을 멈춘다. 다시 발급하지 않는다. 켤 때의 종목 목록 재시도(10초), 07:45 목록 갱신 재시도, 20:05 토큰 재발급도 멈춘다. 종목 목록을 기다리는 요청(`/api/symbols`, `/api/bars`)도 기다리지 않고 곧바로 `kiwoom_auth_failed`다. 오류 문장과 `error` 로그에 원인과 조치를 적는다(`auth::auth_failed_message`). 운영자가 고치고 서버를 다시 켠다. |
| 지정단말기 인증 실패 | 상세 코드 **8050** | 위와 같이 멈춘다. 문장: "키움 IP 미등록 또는 반복 발급 잠금입니다. 지금 공인 IP를 키움 포털에 등록하세요. 반복 발급 잠금이면 포털에서 해제됐는지 확인하세요." 공인 IP는 외부 서비스로 알아내지 않는다. 2026-11-09에 IP 미등록으로 실제로 겪었다(ADR 0004). |
| 한 번에 넣은 종목이 너무 많음 | HTTP 200, `return_code: 5`, 상세 코드 1634(ka10095에 101종목 이상) | 우리 코드의 버그다(§5.3이 100개씩 나눈다). 물러서거나 다시 보내지 않는다. `error` 로그. 1700과 섞으면 같은 요청을 되풀이하게 되므로 반드시 상세 코드로 가른다. |
| 없는 종목 | 성공 응답의 빈 행 | 다시 보내지 않는다. 브라우저에는 `unknown_symbol`. |
| 잘못된 요청 | 상세 코드 1501~1999 | 다시 보내지 않는다. 우리 코드의 버그이므로 `error` 로그. 브라우저에는 `internal`. |
| 상세 코드 없는 실패 | `return_code ≠ 0`, 대괄호 없음 | 잘못된 요청과 같이 다룬다. `return_msg`를 로그에 남긴다. |
| 네트워크 오류, HTTP 5xx | — | `Screen`: 0.5초 뒤 한 번만 다시 보낸다. 실패하면 `kiwoom_unavailable`. `Recovery`·`Background`: 1·2·4초 간격으로 세 번까지. |
| 응답 파싱 실패 | — | 다시 보내지 않는다. 응답 원문 앞 2KB를 `error` 로그로 남긴다(차트·종목 조회 응답만. §11.3). |

공식 명세의 오류 코드 목록(1501~1999, 8001~8200)은 실측 프로그램이 참고한 `kiwoom_api_spec.json`의 `error_codes`에 있다.

### 4.4 시세 API만 허용

실계좌 키는 주문도 넣을 수 있다. 그래서 시세 API 외에는 **표현할 수 없게** 만든다.

```rust
/// 허용 목록. 이 enum에 없는 api-id는 보낼 수 없다.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum ApiId {
    Au10001, // 접근토큰 발급              /oauth2/token
    Ka10099, // 종목정보 리스트            /api/dostk/stkinfo
    Ka10100, // 종목정보 하나              /api/dostk/stkinfo
    Ka10095, // 지정종목 정보(여러 종목 현재가, 한 번에 100개까지) /api/dostk/stkinfo
    Ka10080, // 주식 분봉                  /api/dostk/chart
    Ka10081, // 주식 일봉                  /api/dostk/chart
    Ka10082, // 주식 주봉                  /api/dostk/chart
    Ka10083, // 주식 월봉                  /api/dostk/chart
    Ka20005, // 업종 분봉                  /api/dostk/chart
    Ka20006, // 업종 일봉                  /api/dostk/chart
    Ka20007, // 업종 주봉(배열 inds_stk_pole_qry) /api/dostk/chart
    Ka20008, // 업종 월봉(배열 inds_mth_pole_qry) /api/dostk/chart
}

impl ApiId {
    pub const fn path(self) -> &'static str; // 위 주석의 경로만 나온다
}

mod sealed { pub trait Sealed {} }

/// 요청 하나의 타입. 봉인되어 있어 kiwoom 모듈 밖에서 새 요청을 만들 수 없다.
pub trait MarketRequest: sealed::Sealed + serde::Serialize {
    const API_ID: ApiId;
    type Response: serde::de::DeserializeOwned;
}
```

- `KiwoomRest`가 쓰는 URL 경로는 `ApiId::path()`에서만 나온다. 경로 문자열을 직접 받는 함수는 없다.
- 실시간 type도 허용 목록이다: `0B`(주식체결), `0J`(업종지수). 주문체결(`00`), 잔고(`04`) 같은 계좌 실시간은 enum에 없다.
- **구조 검사 테스트**: `server/src` 전체에서 `/api/dostk/ordr`, `/api/dostk/acnt`, `kt1`로 시작하는 api-id 문자열이 나오면 실패한다. 누가 실수로 주문 API를 넣으면 CI가 막는다.

### 4.5 요청 타입 예시

```rust
// 주봉 WeeklyChart(ka10082), 월봉 MonthlyChart(ka10083)도 같은 매크로로 만든다.
#[derive(Serialize)]
pub struct DailyChart {           // ka10081
    stk_cd: String,               // kiwoom_stock_code(...)로만 만든다
    base_dt: String,              // 필수(빠지면 1511). 시리즈를 만든 날(KST, YYYYMMDD). §6.3
    upd_stkpc_tp: &'static str,   // 언제나 "1"(수정주가)
}
impl sealed::Sealed for DailyChart {}
impl MarketRequest for DailyChart {
    const API_ID: ApiId = ApiId::Ka10081;
    type Response = wire::DailyChartResponse;
}

impl DailyChart {
    /// today는 시리즈의 `today`, 곧 시리즈를 만든 날이다(§6.2). 07:45에 시리즈를 모두 비우므로
    /// 한 시리즈의 조회는 모두 같은 base_dt를 쓴다. 자정부터 07:45까지는 전날 날짜일 수 있다.
    pub fn new(code: StockCode, venue: Venue, today: KstDate) -> Self;
}

// 지수: IndexDailyChart(ka20006), IndexWeeklyChart(ka20007), IndexMonthlyChart(ka20008).
// 본문은 { inds_cd, base_dt }이고 수정주가 필드가 없다.

// #14에서 더한다. 주식 분봉의 base_dt는 언제나 시리즈의 `today`다. 지수 분봉만 과거 날짜로 바로 간다(§6.3).
#[derive(Serialize)]
pub struct MinuteChart {          // ka10080
    stk_cd: String,               // kiwoom_stock_code(code, venue)
    tic_scope: String,            // Period::minutes(): "1" "3" "5" "15" "30" "60"
    upd_stkpc_tp: &'static str,   // "1"
    base_dt: String,              // 언제나 시리즈의 `today`(수정주가 기준, §6.3)
}

#[derive(Serialize)]
pub struct IndexMinuteChart {     // ka20005
    inds_cd: String,
    tic_scope: String,
    base_dt: String,              // 최신 페이지는 시리즈의 `today`. 묵은 키에서는 가진 가장 이른 봉의 날짜
}

impl MinuteChart {
    /// 분봉 주기가 아니면 None.
    pub fn new(code: StockCode, venue: Venue, period: Period, base: KstDate) -> Option<Self>;
}
```

- **분봉 응답**(kiwoom.md 1·2·13절): 한 페이지 900봉, 최신순. `cntr_tm`은 `YYYYMMDDHHMMSS`이고 구간이 시작하는 KST다. `_AL`·KRX·`_NX` 모두 행 모양이 같다. 시·고·저·종에 부호가 붙는다(§4.6).
- **`base_dt`로 과거로 바로 가기**: `base_dt`에 과거 날짜를 넣으면 그날의 마지막 봉부터 거꾸로 온다. 예를 들어 `base_dt=20260601`이면 첫 봉이 `20260601195900`이다(kiwoom.md 1절). ka20005도 같다. 주식은 이때 그 날짜 뒤의 권리발생이 빠진 가격이 온다(kiwoom.md 4.1절). 그래서 서버는 이 조회를 지수 분봉에만 쓴다.

### 4.6 응답 단위와 부호

파서(`server::kiwoom::wire`)는 응답을 `domain` 타입으로 바꾼다. 숫자는 모두 문자열로 온다.

**가격 부호를 믿지 않는다.** 가격은 언제나 앞의 `+`/`-`를 떼고 절댓값으로 읽는다. 부호의 기준이 TR마다 다르고, 지수 분봉은 `--32411`처럼 이중 부호도 온다(kiwoom.md §7). 등락 방향이 필요하면 방향 필드(`pred_pre_sig`: 1 상한, 2 상승, 3 보합, 4 하한, 5 하락)를 읽는다.

| 원천 | 가격 원문 예 | 내부 `Price`(centi) | 브라우저 | 거래량 |
|---|---|---|---|---|
| ka10080/81/82/83 주식 | `"193500"`, `"-193400"` | 절댓값 × 100 → `19_350_000` | `193500` | 주. `trde_qty` |
| ka20005/06/07/08 지수 | `"505969"`, `"-505969"` | 절댓값 그대로 → `505_969`(이미 100배 정수) | `5059.69` | 단위 미확인(천 주로 보임). 받은 값 그대로 |
| 0B 주식 실시간 | `"+71500"`(명세) | 절댓값 × 100 | 원 | 필드 15의 절댓값(주) |
| 0J 지수 실시간 | `"-1327.93"`(소수 2자리 문자열, 방향 부호) | 부호를 떼고 소수점 둘째 자리까지 읽어 centi로 → `132_793` | 포인트 | 필드 13 누적거래량. 단위 미확인(천 주로 보임) |

- 지수 REST 경로에 주식의 "× 100"을 적용하면 지수가 100배가 된다. 그래서 변환 함수는 TR마다 따로 두고 `Price::from_centi`만 부른다. 공통 "자연 단위 → centi" 함수는 두지 않는다. 코드는 `wire::PriceScale`(`StockWon`, `IndexCenti`)로 가른다.
- **0J는 REST 지수와 파서를 따로 둔다**(#4, D16): REST 지수는 100배 정수이고 0J는 소수 문자열이다(kiwoom.md 11.5). 0J의 시가·고가·저가·현재가(16, 17, 18, 10)에도 방향 부호가 붙으므로 절댓값을 쓴다.
- **시고저종이 맞지 않는 행**: 실제 키움 행 중 `low ≤ open, close ≤ high`를 어기는 것이 있다. 실측으로 코스피 일봉 9행, 코스닥 일봉 59행을 찾았다(예: 코스피 1996-11-04). 행 하나를 거절하면 그 페이지 전체가 실패하고, 행을 버리면 구간에 구멍이 생긴다. 그래서 파서(`parse_row`)는 고가를 네 값의 최대로, 저가를 네 값의 최소로 넓혀 받고 `warn` 로그를 남긴다. 이 규칙은 주식 행에도 같게 적용된다. 고정 입력은 `ka20006_001_19961104.json`이다.
- 거래대금(`trde_prica`)은 읽지 않는다(§2.2). 단위가 일봉·지수 일봉은 백만원, 주·월봉은 원으로 TR마다 다르다.
- `upd_rt`, `upd_stkpc_tp`, `kind`처럼 명세에 없는 필드가 섞여 와도 무시한다(`#[serde(deny_unknown_fields)]`를 쓰지 않는다).

```rust
// server::kiwoom::wire
/// 행은 최신순으로 온다. 결과는 오름차순으로 돌려준다. 응답 타입마다 배열 이름과 PriceScale이 정해져 있다.
pub fn parse_chart<B: ChartBody>(body: B, period: Period) -> Result<ChartRows, WireError>;

pub enum ChartRows {
    /// 빈 행 하나: 없는 코드.
    UnknownSymbol,
    Rows(Vec<KiwoomBar>),
}

/// 키움에서 받은 봉. 마지막 봉은 진행 중인 구간일 수 있다.
pub struct KiwoomBar {
    pub bucket: Bucket,
    pub ohlcv: Ohlcv,
    // #4에서 더한다: day_cum: Option<Volume>. 분봉 행의 acc_trde_qty, 일봉 행의 trde_qty.
    // 현재 봉 시드 경계 후보(§5.4).
}

pub fn parse_real_0b(values: &RealValues, received_at: KstTime) -> Result<RealTrade, WireError>;
pub fn parse_real_0j(values: &RealValues, received_at: KstTime, prev_cum: Option<Volume>) -> Result<RealTrade, WireError>;

/// 체결 하나와 그 순간의 현재가 정보.
pub struct RealTrade { pub trade: Trade, pub direction: Direction, pub abs_change: Price /* |전일대비| */ }
pub enum Direction { UpperLimit, Up, Flat, LowerLimit, Down }
```

#### 현재가의 등락

현재가(`Quote`)의 등락은 **기준가와 방향 필드**로 계산한다. 가격 부호로 계산하지 않는다.

- 기준가는 등락의 기준이 되는 가격이다(보통 전일 종가). 종목마다 그날 한 번 정한다.
  - 실시간이 있으면 첫 0B에서 `기준가 = 현재가 − 방향 부호 × |전일대비|`로 구한다. 방향 부호는 상승·상한이면 +1, 하락·하한이면 −1, 보합이면 0이다.
  - 실시간이 없으면(#3, 넘친 관심종목) ka10095를 쓴다. 기준가는 `base_pric`(부호 없음), 방향은 `pred_pre_sig`, 현재가는 `cur_prc`의 절댓값이다. 실측에서 100종목 모두 `|cur_prc| − base_pric = pred_pre`가 성립했고, `pred_pre_sig`도 `cur_prc` 부호와 맞았다(kiwoom.md §10.6).
  - ka10099의 `lastPrice`는 마지막 관측일의 기준가였다(kiwoom.md §5). 현재가로 쓰지 않는다. 장중에 이 값이 오늘 기준가인지는 [장중 실측 대기]다.
- `change = 현재가 − 기준가`, `changeRate = change / 기준가 × 100`.
- 계산한 `change`의 부호가 방향 필드와 어긋나면 `warn` 로그를 남긴다. 값은 계산한 것을 쓴다.

---

## 5. 실시간

> 켜지는 단계: #4(구독 관리자의 알림 보유자는 #8, 비교 종목은 #5)

### 5.1 WebSocket 세션

토큰 하나에 세션 하나다(공지 49). 서버 안에서도 세션은 언제나 하나다.

```rust
enum SessionState {
    Disconnected { since: KstTime, retry_at: KstTime, attempt: u32 },
    Connecting,
    LoggingIn { gen: TokenGen },
    Live { since: KstTime, session: SessionId, gen: TokenGen },
    /// 인증 실패. 운영자가 고칠 때까지 다시 연결하지 않는다.
    Halted,
}

pub struct KiwoomStream { /* 내부 태스크 하나 */ }

impl KiwoomStream {
    /// 받아야 할 종목 전체 집합을 통째로 준다. 세션이 차이를 계산해 REG/REMOVE를 보낸다.
    pub fn set_desired(&self, desired: BTreeSet<Symbol>);
    pub fn events(&self) -> mpsc::Receiver<StreamEvent>;
}

pub enum StreamEvent {
    Trade { symbol: Symbol, real: RealTrade },
    /// 세션이 Live가 되고 원하는 집합을 모두 REG 했다.
    Live { session: SessionId, since: KstTime },
    /// 세션이 끊겼다. 이 시각부터 다음 Live까지는 체결이 빠졌을 수 있다.
    Down { at: KstTime },
    Halted,
}
```

실측으로 확인한 동작(kiwoom.md §8):

- 주소: `wss://api.kiwoom.com:10000/api/dostk/websocket`.
- **LOGIN**: 연결 직후 `{"trnm":"LOGIN","token":…}`을 보낸다. 성공 응답은 `{"trnm":"LOGIN","return_code":0,…}`이다. 성공 응답을 받아야 `Live`로 간다. 인증 실패(§4.3)면 `invalidate`로 토큰을 한 번 다시 받아 재시도한다. 또 실패하면 `Halted`.
- **LOGIN은 앱키당 하나**: 같은 앱키로 다른 곳에서 LOGIN하면 기존 세션이 close 1000 'Bye'로 끊긴다(D16, kiwoom.md 11.9). 서버 하나 원칙(§4.1 잠금 파일)이 이것을 막는다.
- **PING**: 서버가 10초마다 `{"trnm":"PING"}` 텍스트 메시지를 보낸다. 받은 문자열을 그대로 돌려보낸다. WebSocket 프로토콜의 Ping 프레임은 오지 않는다. 30초 동안 아무 메시지도 없으면 연결이 죽었다고 보고 다시 연결한다.
- **REG**: `data`는 `{"item":[…],"type":[…]}`의 배열이다. 한 원소에 종목 여럿을 넣을 수 있고 원소 하나의 한도는 따로 없다. 서버는 type별 원소 하나에 모두 담는다.
- **REG 한도**: 그룹당 200(`105118`), **접속 전체 200**(`105115`)이다. 그룹을 나눠도 늘지 않는다. **0J 지수도 이 200에 든다**(kiwoom.md §10.7). 서버는 §5.3의 `REALTIME_LIMIT`로 미리 지키므로 이 오류는 우리 버그다. 받으면 `error` 로그를 남기고 세션을 다시 연결해 원하는 집합을 처음부터 맞춘다. 그룹 번호는 `grp_no: "1"` 하나만 쓴다. `refresh: "1"`(기존 것 유지)로 보낸다.
- **REMOVE**: **type별로 따로 보낸다.** 0B와 0J를 한 요청에 섞으면 `105112`로 실패한다.
- **한 번에 하나**: REG/REMOVE 응답에는 요청 번호가 없다. 그래서 제어 메시지는 하나씩 보내고 응답을 기다린다. 5초 안에 응답이 없으면 실패로 본다.
- **키움 쪽 목록은 응답을 보고 바꾼다**: 세션은 키움이 받아들인 종목 목록(`accepted`)을 따로 든다. REG·REMOVE의 성공 응답을 받은 뒤에만 `accepted`를 바꾼다. 실패하면 한 번 다시 보낸다. 또 실패하면 세션을 닫고 다시 연결한다. 다시 연결하면 `accepted`를 비우고 원하는 집합 전체를 처음부터 REG 하므로 어긋남이 없어진다. 200 한도 계산(§5.3)은 원하는 집합으로 한다.
- 주식은 `0B`, 지수는 `0J`로 REG 한다. 코드는 `kiwoom_stock_code`가 만든다. 주식은 거래소와 상관없이 `_AL` 하나만 REG 하는 방안을 먼저 검토한다(§5.3, ADR 0007).
- **REAL**: `data[]`의 각 항목을 `parse_real_0b/0j`로 바꾼다. 실패한 항목은 버리고 카운터를 올린다.
- 같은 토큰으로 순서대로 다시 접속하면 매번 LOGIN이 성공했다. 그래서 다시 연결할 때 토큰을 새로 받지 않는다.

### 5.2 다시 연결과 끊긴 구간 복구

- 끊기면 1·2·5·10·30초 간격으로 다시 연결한다. 그 뒤로는 30초 고정이다. 07:50 강제 단절도 같은 경로다. 토큰 세대가 바뀌어도 세션을 닫지 않는다(§4.1).
- **08:00 전에 붙어 있기**: 08:00 정각에 접속하면 첫 체결을 놓칠 수 있다(kiwoom.md 11.9). 07:50 단절 뒤에는 07:55부터 다시 붙어 08:00 전에 `Live`가 되게 한다(D16).
- **20:00 뒤의 연결**: 20:00:00~20:00:03 체결을 받으려고 20:00:10까지는 연결을 그대로 둔다(§3.1). 장이 닫혀도 연결을 일부러 끊지는 않는다.
- 다시 연결되면 LOGIN → 원하는 집합 전체를 다시 REG → `StreamEvent::Live`를 보낸다.
- `MarketHub`는 `Down { at }`과 그다음 `Live { since }` 사이를 **끊긴 구간**으로 본다. 끊긴 구간이 체결 시간([08:00, 20:00))과 겹치지 않으면 메울 것이 없다. 07:50 단절이 대개 그렇다. 겹치면 아래 순서로 복구한다.

**복구 순서**(열려 있는 `SeriesKey`마다)

1. 키에 **복구 세대** `recovery_gen`을 하나 올린다. 키 상태를 `Recovering { gen, from: down_at, buffer }`로 바꾼다.
2. 이 상태에서 들어오는 체결은 `buffer`에 시각순으로 쌓는다. 현재 봉에 바로 넣지 않는다. 브라우저에 `bar`를 보내지 않는다. 가격 알림은 체결마다 그대로 판단한다. 체결 자체는 진짜이기 때문이다.
3. `BarService::refresh_latest(key, Priority::Recovery)`를 부른다. 응답에는 `gen`이 붙어 돌아온다.
4. 응답이 오면 그 키의 `recovery_gen`과 비교한다. 다르면 그 응답은 버린다(복구 중에 또 끊겨 새 복구가 시작된 경우).
5. 같으면:
   1. 받은 확정 봉이 캐시에 들어간다(`BarSource::Kiwoom`, §6.4).
   2. 진행 중 구간의 봉으로 새 현재 봉을 만든다(§5.4의 시드). `buffer`의 체결 중 시드 경계 뒤의 것만 시각순으로 적용한다. 적용하다 구간을 넘으면 그때 봉을 확정한다.
   3. 키 상태를 `Live`로 돌린다. 브라우저에 `reload { reason: "gap_filled", from }`를 보낸다. 브라우저는 칸을 통째로 다시 만든다(§8.3). 새 현재 봉은 그 뒤 `bar`로 간다.
6. 실패하면 상태를 그대로 두고 1·2·5·10·30초 간격으로 3번부터 다시 한다. 그동안 `status.backfilling = true`다.
7. 복구 중에 또 끊기면 1번으로 간다. 이때 `from`은 처음 끊긴 시각을 그대로 둔다.

- **지표 알림**: 끊긴 구간 안에서 확정된 봉으로는 판단하지 않는다. 복구로 받은 봉으로 소급해 울리지도 않는다(D9). 복구 뒤 처음 확정되는 봉부터 다시 판단한다.
- **가격 알림의 한계**: 끊긴 동안의 체결은 조회로 되살릴 수 없다. 조회로 받는 것은 봉뿐이다. 그 사이 가격이 조건을 넘었다 돌아왔으면 가격 알림은 울리지 않는다.

### 5.3 구독 관리자

키움 쪽 구독 단위는 **종목**이다. 브라우저 구독 단위는 **`SeriesKey`**, 곧 (종목, 거래소, 봉 주기)다. 서버는 종목 하나의 체결을 그 종목의 모든 (거래소, 봉 주기) 집계기로 나눠 보낸다.

- **거래소별 현재 봉**(ADR 0007, #4에서 정한다): `_AL` 0B 한 흐름은 KRX와 NXT 체결을 모두 준다. 체결마다 `9081`이 `"KRX"` 또는 `"NXT"`다(kiwoom.md 11.1·11.2). 그래서 `_AL` 하나만 REG 하고, 통합 집계기에는 모든 체결을, KRX·NXT 집계기에는 `9081`이 맞는 체결만 넣는 방안을 먼저 검토한다. 이러면 거래소를 골라도 REG 수가 늘지 않는다.
- 애프터마켓 시간대(16:00~20:00)의 `9081` 값은 아직 재지 않았다(§12.2). 이 값이 거래소를 가르지 못하면 KRX·NXT 칸은 거래소 코드(`005930`, `005930_NX`)를 따로 REG 해야 하고, 200 한도 계산도 그 수로 한다.

```rust
/// 누가 이 종목의 구독을 잡고 있는가.
#[derive(Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Holder {
    /// 브라우저 연결 하나의 구독 하나. 칸의 주 종목과 비교 종목 모두 여기에 든다.
    Cell { conn: ConnId, sub: SubId },
    Alert(AlertId),
    Watchlist,
}

pub struct SubscriptionManager {
    holders: BTreeMap<Symbol, BTreeSet<Holder>>,
    /// 보유자가 모두 빠진 시각. 30초 뒤 해지 후보.
    released_at: BTreeMap<Symbol, KstTime>,
    /// 지금 실시간으로 받기로 허락된 종목. 계획이 바뀌어도 함부로 빼지 않는다.
    admitted: BTreeSet<Symbol>,
}

pub const RELEASE_GRACE_SECS: i64 = 30;
/// 키움 접속 전체 한도. 0B 종목과 0J 지수를 더해서 센다(kiwoom.md §10.7).
pub const REALTIME_LIMIT: usize = 200;

pub struct Plan {
    /// 키움에 REG 할 집합. 크기 ≤ 200.
    pub realtime: BTreeSet<Symbol>,
    /// 한도를 넘어 1분마다 조회로 현재가를 받을 관심종목.
    pub polled: BTreeSet<Symbol>,
    /// 한도를 넘어 받을 수 없는 칸·알림 보유자. 브라우저와 알림 목록에 알린다.
    pub rejected: BTreeSet<Holder>,
}

impl SubscriptionManager {
    /// 30초 유예 중인 종목이면 유예를 취소한다.
    pub fn hold(&mut self, symbol: Symbol, h: Holder);
    pub fn release(&mut self, symbol: Symbol, h: &Holder, now: KstTime);
    /// 연결이 끊긴 브라우저의 모든 구독을 놓는다.
    pub fn release_conn(&mut self, conn: ConnId, now: KstTime);
    /// 같은 상태와 now면 언제나 같은 계획. admitted를 갱신한다.
    pub fn plan(&mut self, now: KstTime) -> Plan;
}
```

`plan`의 규칙:

0. **지수 몫**: 0J 지수도 200에 든다. 그리고 지수는 ka10095로 조회할 수 없어 넘쳐도 1분 조회로 돌릴 수 없다. 그래서 누가 잡았든(관심종목만이라도) 지수는 칸과 같은 우선순위로 받는다. 종목이 쓸 수 있는 자리는 `200 − 받는 지수 수`다. v1의 지수는 코스피·코스닥 둘뿐이라 종목 자리는 198 이상이다.
1. **유지**: `admitted`에 있는 종목 중 보유자가 있거나 30초 유예 중인 종목은 그대로 둔다. 새 종목이 들어온다고 칸·알림이 잡은 종목을 밀어내지 않는다.
2. **빼기**: 보유자가 없고 30초가 지난 종목은 `admitted`에서 뺀다.
3. **새로 받기**: `admitted`에 없는 후보를 우선순위 순서로 넣는다. 우선순위는 칸 > 알림 > 관심종목만 잡은 종목이다. 같은 우선순위 안에서는 보유자가 생긴 시각이 이른 순서다.
4. **자리가 없을 때**: 새 후보가 칸이나 알림이면 자리를 만든다. 먼저 30초 유예 중인 종목을 뺀다. 그래도 없으면 관심종목만 잡은 종목을 뺀다. 둘 다 없으면 그 보유자는 `rejected`다.
5. 관심종목만 잡았는데 실시간에 못 든 종목은 `polled`로 간다. 1분마다 `Ka10095`로 **100종목씩** 묶어 조회한다(`Background`). 101종목 이상은 `1634`로 거절된다.
6. **회복**: 자리가 나면 `rejected`였던 보유자를 3번 규칙으로 다시 넣는다. 들어가면 알린다. 칸이면 같은 `sub`로 `subscribed`를 다시 보낸다. 알림이면 `Alert.warning`을 `null`로 되돌린다.

`MarketHub`는 보유자가 바뀔 때와 1초 타이머마다 `plan`을 다시 계산한다. `realtime`이 바뀌었으면 `KiwoomStream::set_desired`를 부른다.

관심종목 현재가는 실시간 구독이든 조회든 같은 `quotes` 메시지로 브라우저에 간다(§8.3). `source` 필드로 어느 쪽인지 알린다.

### 5.4 현재 봉 집계(순수 함수, `domain::aggregate`)

```rust
pub enum Applied {
    /// 현재 봉에 더했다.
    Updated,
    /// 새 구간의 체결이라 앞 봉을 확정하고 새 현재 봉을 시작했다.
    Rolled { confirmed: ConfirmedBar },
    /// 시드에 이미 들어 있는 체결이거나, 확정이 끝난 구간의 체결(늦은 체결)이다.
    Ignored(IgnoreReason),
}

impl CurrentBar {
    /// 키움 조회에서 받은 진행 중 구간의 봉으로 시작한다.
    pub fn seed(bar: KiwoomBar, boundary_trusted: bool) -> Self;
    pub fn bucket(&self) -> Bucket;
    pub fn ohlcv(&self) -> &Ohlcv;
    /// SeedBoundary::Unknown 이거나, 경계 판단에 실패한 체결을 받은 적이 있으면 false.
    pub fn is_complete(&self) -> bool;
}

/// 체결 하나를 반영한다. state가 None이면 이 체결로 새 현재 봉을 시작한다(FromTrade).
pub fn apply_trade(state: &mut Option<CurrentBar>, period: Period, trade: &Trade) -> Applied;

/// confirm_at이 지났으면 현재 봉을 확정하고 비운다.
pub fn close_if_due(state: &mut Option<CurrentBar>, now: KstTime) -> Option<ConfirmedBar>;

/// 테스트용: 체결 목록 전체를 접는다.
pub fn aggregate(period: Period, seed: Option<CurrentBar>, trades: &[Trade], now: KstTime)
    -> (Vec<ConfirmedBar>, Option<CurrentBar>);
```

- 체결 하나는 그 종목의 열린 봉 주기 집계기 모두에 들어간다. 일·주·월봉 현재 봉도 체결로 직접 만든다. 다른 봉 주기의 봉에서 만들지 않는다(ADR 0003).
- **시드**: 종목을 처음 열 때 받은 키움 조회의 마지막 봉이 진행 중 구간이면, 그 봉이 현재 봉의 시작점(시드)이다.
- **시드 경계**: 시드에 어디까지의 체결이 들어 있는지 알아야 그 뒤 체결만 더할 수 있다. 서버가 응답을 받은 시각은 그 경계가 아니다. 키움이 스냅숏을 만든 시각과 응답이 도착한 시각 사이의 체결이 빠지기 때문이다. 그래서 수신 시각은 쓰지 않는다.
  - **후보**: 당일 누적거래량. 분봉 행의 `acc_trde_qty`와 0B 필드 13을 쓴다. 0B의 누적거래량이 시드의 값 이하인 체결은 이미 들어 있다.
  - 이 둘이 같은 기준인지는 [장중 실측 대기]다. 분봉 `acc_trde_qty`는 분봉 합과 같고 일봉 거래량과는 다르다(kiwoom.md §3).
  - **확인 전 기본값**: 경계를 믿지 않는다(`boundary_trusted = false` → `SeedBoundary::Unknown`). 시드 뒤 모든 체결을 더한다. 그 현재 봉은 불완전하다.
  - 일·주·월봉 시드는 확인 뒤에도 일봉 `trde_qty`의 기준이 0B와 같을 때만 믿는다.
- **불완전한 봉의 처리**
  - 화면에는 그대로 보낸다.
  - 확정되면 `needs_verify = true`인 `Realtime` 봉으로 캐시에 들어간다. 그 즉시 그 키의 `refresh_latest(Priority::Recovery)`를 예약해 키움 값으로 바꾼다.
  - 지표 알림은 키움 값으로 바뀐 뒤 그 봉을 **처음으로** 판단한다. 소급이 아니라 첫 판단이다.
  - 시드 다음 구간부터는 체결로 시작하므로 완전하다. 그래서 불완전한 봉은 키마다 시드 직후 하나뿐이다.
- **구독을 조회보다 먼저**: 실시간 REG를 조회보다 먼저 한다. REG와 조회 사이에 들어온 체결은 집계기 앞에 쌓아 둔다. 시드가 오면 경계 뒤의 것만 반영한다.

### 5.5 `MarketHub` 액터와 `seq`

실시간 상태는 태스크 하나가 혼자 가진다. 락이 없다.

```rust
enum HubInput {
    Stream(StreamEvent),
    Tick(KstTime),                                       // 1초마다
    Subscribe { conn: ConnId, sub: SubId, key: SeriesKey, reply: oneshot::Sender<SubscribeReply> },
    Unsubscribe { conn: ConnId, sub: SubId },
    ConnClosed(ConnId),
    Seeded { key: SeriesKey, recovery_gen: Option<u64>, result: Result<RefreshResult, BarError> },
    Snapshot { key: SeriesKey, reply: oneshot::Sender<HubSnapshot> },
    WatchlistChanged(BTreeSet<Symbol>),
    AlertsChanged(Vec<AlertSpec>),
    Polled(Vec<Quote>),
}

/// REST 최신 페이지를 만들 때 BarService가 받는다.
pub struct HubSnapshot {
    pub seq: u64,
    pub current: Option<CurrentBar>,
    /// 아직 캐시에 쓰이지 않았을 수 있는 최근 확정 봉. 페이지가 이것까지 합친다.
    pub recent_confirmed: Vec<ConfirmedBar>,
}
```

- **`seq`**: 서버는 `SeriesKey`마다 하나씩 늘어나는 번호 `seq`를 둔다. 이 흐름의 `bar`, `confirmed`, `reload` 메시지를 만들 때마다 1씩 올리고 메시지에 붙인다. `subscribed`에는 지금의 `seq`를 붙인다. 같은 키를 구독한 모든 브라우저 구독이 같은 번호를 본다. 서버가 다시 켜지면 0부터 다시 센다. 브라우저도 다시 연결되면 시리즈를 다시 만든다(D2).
- **`BarsPage.seq`**: 최신 페이지를 만들 때 `BarService`는 `Snapshot`을 한 번 받는다. 그 스냅숏의 `seq`, `current`, `recent_confirmed`가 같은 순간의 값이다. 그래서 페이지는 "seq까지 반영한 상태"가 된다. 실시간이 없는 단계(#2·#3), 그 키에 실시간 집계기가 없을 때, 과거 페이지에서는 `seq`가 `null`이다.
- **체결 하나의 처리 순서**
  1. 가격 알림 판단.
  2. 그 종목의 각 `SeriesKey` 집계기에 `apply_trade`.
  3. `Rolled`면 확정 봉을 `recent_confirmed`에 넣는다. `BarService::append_realtime`으로 넘긴다. 지표 알림 판단을 예약한다.
  4. 그 키를 구독한 브라우저 구독들에 갱신 표시를 한다. 실제로 보내는 일은 연결마다의 쓰기 태스크가 한다(§8.4).
- `recent_confirmed`는 캐시 쓰기가 끝났다는 응답을 받으면 비운다.

---

## 6. 캐시 (ADR 0003)

> 켜지는 단계: #2(일·주·월, 메모리 시리즈, 07:45 비우기), #14(거래소별 시리즈, 분봉 과거 조회), #4(실시간으로 만든 봉, 끊긴 구간)

### 6.1 저장 위치

| 계층 | 내용 | 수명 |
|---|---|---|
| 서버 메모리 | 열려 있는 `SeriesKey`의 확정 봉과 캐시 구간, 종목 목록 | 시리즈는 쓰는 곳이 없어지고 10분 뒤 내린다. 매일 07:45에 모두 버린다. 서버를 끄면 사라진다 |
| 브라우저 메모리 | §8 참고 | 탭 수명 |

- 시세는 디스크에 남기지 않는다(ADR 0003). SQLite 파일(#3부터)에는 사용자 자료만 둔다.
- 서버를 다시 켜면 캐시는 빈 상태다. 차트를 열면 키움에서 다시 받는다. 처음 열 때 일봉·분봉 1회, 주봉 2회, 월봉 3회 조회라 몇 초 안에 뜬다(§6.5).
- 키움이 응답하지 않으면(점검 시간 등) 이미 메모리에 있는 시리즈만 보인다. 새로 여는 차트는 `kiwoom_unavailable`이다. ADR 0003이 받아들인 비용이다.
- 현재 봉은 캐시하지 않는다. 캐시에 넣는 함수는 `ConfirmedBar`만 받는다.
- 크기: 가장 큰 것은 1분봉 1년(약 17만 봉)이다. 봉 하나를 약 60바이트로 잡으면 시리즈 하나가 약 10MB다. 거래소는 시리즈를 따로 두므로, 한 종목을 세 거래소로 모두 열면 약 30MB다. 개인용에서 문제 되지 않는다.

### 6.2 메모리 구조

```rust
pub struct BarService {
    rest: KiwoomRest,
    symbols: Arc<SymbolDirectory>,
    clock: Clock,
    /// 열려 있는 시리즈. 키마다 Slot 하나.
    slots: Mutex<HashMap<SeriesKey, Arc<Slot>>>,
    /// 시리즈를 새로 만들 때마다 1씩 는다. 프로세스 안에서 유일하다.
    next_id: AtomicU64,
    /// 07:45 비우기마다 1씩 는다. 키움 조회의 합치기 범위(MergeScope)다.
    resets: AtomicU64,
}

struct Slot {
    /// 이 시리즈를 만든 순간 받은 번호(세대). 내렸다가 다시 만들면 바뀐다.
    id: SeriesId,
    /// 마지막으로 REST 페이지 요청을 받은 시각(Unix 초). 10분 내리기 판단에 쓴다.
    last_access: AtomicI64,
    /// 최신 페이지를 키움에서 받은 횟수. 키별 잠금을 기다린 요청이 그사이 받은 결과를 다시 쓰는 데 쓴다.
    latest_fetches: AtomicU64,
    /// 키별 잠금. 이 잠금이 한 시리즈의 읽기와 쓰기를 줄 세운다.
    series: tokio::sync::Mutex<Series>,
}

/// 메모리의 시리즈 하나 = 캐시 구간 하나.
struct Series {
    /// 최신 페이지와 일·주·월봉 조회가 쓰는 base_dt. 시리즈를 만든 날이다.
    today: KstDate,
    /// 오름차순. 캐시 구간 [oldest, newest] 안에서 빠짐이 없다.
    bars: Vec<ConfirmedBar>,
    /// 키움이 더 과거를 주지 않는다(cont-yn: N).
    reached_origin: bool,
    /// 가진 가장 이른 봉 바로 앞을 가리키는 연속조회.
    cont: Option<Cont>,
    /// 마지막 최신 페이지 조회가 준 진행 중 구간의 봉. 캐시 구간에는 넣지 않는다.
    current: Option<KiwoomBar>,
}

/// 연속조회 키와, 그 키를 낸 조회의 base_dt(이어 받을 때 같은 본문을 보낸다), 받은 시각.
struct Cont {
    key: ContKey,
    base: KstDate,
    received_at: KstTime,
}

pub struct SeriesId(u64);
```

- **캐시 키**: `SeriesKey` = (종목, 거래소, 봉 주기). 봉 하나의 키는 (종목, 거래소, 봉 주기, `t`)다.
- **#4에서 더할 것**: 실시간으로 만든 봉을 붙이려면 "키움에서 받은 가장 늦은 봉"(`kiwoom_newest`)을 시리즈가 알아야 한다(§6.3 앞으로 늘리기). #2에는 실시간 쓰기가 없어서 이 필드가 없다.
- **내리기**: 시리즈를 "쓰는 곳"은 그 키의 브라우저 구독(#4), 그 키를 잡은 켜진 알림(#8), 최근 10분 안의 REST 요청이다. 셋 다 없게 된 지 10분이 지나면 맵에서 지운다. 1분 타이머가 판단한다. #2·#3에는 구독이 없으므로 마지막 REST 요청으로부터 10분이다.
- **매일 07:45에 모두 비우기**(ADR 0003)
  - 07:45:00에 시리즈 맵을 통째로 비운다. 키움이 수정주가를 다음 날 반영해 주면, 다시 받은 봉은 수정주가로 온다. 그래서 수정주가 대조는 하지 않는다. 키움이 언제 반영하는지는 [실측 대기]다(§12.3).
  - 그 시각에 `MarketHub`의 현재 봉 집계기도 모두 비운다. 주봉·월봉 현재 봉의 시드도 옛 가격일 수 있기 때문이다.
  - 구독 중인 키(#4)는 바로 다시 채운다. `refresh_latest(Priority::Recovery)`로 최신 페이지를 받고 현재 봉을 다시 시드한 뒤, 브라우저에 `reload { reason: "daily_reset" }`을 보낸다.
  - #2·#3의 브라우저는 알림을 받을 길이 없다. 다음 요청(종목·봉 주기 변경, 새로고침) 때 새 값을 받는다.
  - 종목 목록도 같은 시각에 다시 받는다(§6.6).
  - 07:45는 NXT 프리마켓(08:00) 전이고 07:50 강제 단절 전이다. 체결이 없는 시간이라 실시간으로 만든 봉을 잃지 않는다. 전날 20:05 정리 조회(§6.4)로 이미 키움 값으로 바뀌어 있다.

### 6.3 구간이 끊기지 않게 하기

**불변식**: `SeriesKey`마다 캐시 구간은 하나다. `[oldest, newest]` 안에서 키움에 있는 확정 봉은 메모리에도 모두 있다. 구간 밖의 봉은 메모리에 없다.

- 구간은 양 끝으로만 늘어난다. 구간 사이에 구멍이 생기는 쓰기는 하지 않는다.
- **수정주가 기준을 고정한다**(W4-04)
  - 일·주·월봉 조회는 언제나 `base_dt = 시리즈의 `today``(시리즈를 만든 날), `upd_stkpc_tp = 1`에서 시작해 연속조회로 과거로 내려간다. 이 경로로 받으면 과거 전체가 그날 기준의 수정주가로 온다(kiwoom.md §4).
  - 주식은 일·주·월봉과 분봉 모두(분봉은 PR #15 리뷰 R1) 과거 날짜를 `base_dt`로 바로 가는 조회를 쓰지 않는다. 그 날짜 뒤의 권리발생이 반영되지 않는다. 분봉에서 실측했다(kiwoom.md 4.1절: 알테오젠 07-16 15:00 60분봉 종가가 `base_dt=20261109`에서 212,767원, `base_dt=20260716`에서 276,500원). 요청 생성자의 날짜 인자에는 시리즈의 `today`만 넘긴다.
  - 07:45에 시리즈를 모두 비우므로, 한 시리즈 안에 서로 다른 날 기준의 봉이 섞이지 않는다.
  - 브라우저의 `before` 커서는 "어디까지 내려갈지"일 뿐이다. 수정주가 기준일(`today`)과 다르다.
  - 지수에는 수정주가가 없다. 일·주·월봉은 같은 규칙을 그대로 쓴다. 지수 분봉만 아래 예외로 과거 날짜에 바로 간다.
- **과거로 늘리기**(스크롤, `extend_older`)
  - `oldest`보다 이른 봉이 필요하면 시리즈의 `cont`(가진 가장 이른 봉 바로 앞을 가리키는 연속조회 키)로 한 페이지를 받는다.
  - `next-key`는 15분 묵혀도 통했고 이어 받은 봉에 빠짐·겹침이 없었다(kiwoom.md §10.3). 그래서 기억한 키가 15분(`CONT_FRESH_SECS`) 안이면 그대로 쓴다.
  - **키로 받은 페이지를 믿는 조건**: 새 페이지의 가장 늦은 봉이 시리즈의 가장 이른 봉보다 일러야 한다. 휴장일이 있어서 "바로 앞 봉"인지까지는 확인할 수 없다. 조건이 맞지 않으면 그 페이지를 버린다.
  - 키가 없거나, 15분이 넘었거나, 위 조건이 맞지 않으면 오늘부터 다시 따라간다(`follow_from(today)`). 처음부터 연속조회 체인을 따라 내려가고, 가진 구간 아래로 한 페이지 넘어가면 멈춘다. 받은 페이지 중 이미 메모리에 있는 부분은 키움 값으로 덮어쓴다. 이것은 출처 교체(§6.4)이기도 하다. [실측 대기: 15분 넘는 유효 시간, 장중에 새 봉이 붙는 동안의 키]
  - 키움이 더 줄 것이 없으면(`cont-yn: N`) `reached_origin = true`.
  - 연속조회 키와 `reached_origin`은 받은 페이지가 가진 구간의 가장 이른 봉까지 내려왔거나, 키움이 연속조회를 끝냈을 때(`cont-yn: N`)만 바꾼다. 뒤의 경우가 없으면 가장 이른 봉에 닿지 못한 마지막 페이지에서 과거 늘리기가 끝나지 않는다.
- **주식 분봉의 묵은 키: 오늘부터 다시 따라간다**(PR #15 리뷰 R1)
  - 주식 분봉도 키가 없거나 15분을 넘겨 묵었으면 `follow_from(today)`다. 첫 페이지부터 가진 구간 아래로 한 페이지 넘어갈 때까지 연속조회를 다시 따라간다. 겹친 봉은 같은 기준의 키움 값으로 덮어쓴다.
  - **받아들인 비용**: 따라가는 페이지 수는 가진 봉 수에 비례한다(1분봉 `_AL` 900봉에 1페이지). 1년 끝 가까이 내려가 있던 1분봉 `_AL`이면 약 191페이지, 초당 4회로 약 48초다. 60분봉은 3~4페이지다. 칸이 15분 넘게 과거로 스크롤하지 않다가 다시 과거로 갈 때만 생긴다.
  - 그동안 그 칸의 과거 요청 하나가 응답을 기다린다. 서버(`/api/bars`)와 브라우저에는 요청 시간 제한이 없다. 키움 호출 하나에만 15초 제한이 있다. 브라우저는 과거 요청을 한 번에 하나만 보낸다(`olderInFlight`). 가진 봉은 그대로 보이고, 실패하면 지금처럼 과거 실패 안내(`olderError`)를 띄운다.
  - 이 PR은 과거 페이지 로딩 표시를 따로 두지 않는다. 긴 대기가 실제로 불편하면 칸에 "과거 봉을 받는 중" 표시를 붙인다(제안).
  - 과거 날짜로 건너뛰고 겹친 날의 비율로 맞추는 방법은 쓰지 않는다. 모든 권리발생에서 가격과 거래량이 한 비율로 바뀐다는 근거가 없다. 실측한 권리발생 하나에서도 가격만 바뀌고 거래량은 그대로였다(kiwoom.md 4.1절).
- **지수 분봉의 예외: 묵은 키는 날짜로 건너뛴다**(#14)
  - 지수 분봉(ka20005)에서 연속조회 키가 없거나 15분을 넘겨 묵었으면 가진 가장 이른 봉의 KST 날짜를 `base_dt`로 두고 바로 그날로 간다(`follow_from(그날)`).
  - 지수에는 수정주가가 없어(ka20005 본문에 수정주가 필드가 없다) 어느 `base_dt`로 받아도 같은 값이다. 그래서 비용을 아낀다. 코스피 1분봉 1년은 105페이지다(kiwoom.md 2절).
  - 그날 페이지에는 이미 가진 봉(그날 가장 이른 봉부터 19:59까지)이 겹쳐 온다. 겹친 봉은 키움 값으로 덮어쓴다(같은 `t`). 그 페이지의 연속조회 키가 다음 과거 페이지를 가리킨다.
  - 키를 믿는 조건이 맞지 않을 때(위)도 같은 방법으로 건너뛴다.
  - 경계: `Feed::Index`이고 분봉일 때만이다(`bars.rs` `extend_older`). 주식(`Feed::Stock`)은 거래소와 상관없이 위의 오늘 기준 경로다.
- **앞으로 늘리기**(최신으로 따라잡기, `refresh_latest`)
  - #2: 최신 페이지 한 장을 받는다. 그 페이지의 가장 이른 확정 봉이 메모리의 가장 늦은 봉과 같거나 이르면 이어 붙인다. 이어지지 않으면 시리즈를 비우고 받은 페이지로 새로 만든다. `info` 로그를 남긴다.
  - #4: 최신 페이지부터 받아 과거로 연속조회한다. 받은 봉이 `kiwoom_newest`에 닿으면 멈춘다. 그러면 그 사이의 실시간으로 만든 봉이 모두 키움 값으로 바뀐다. 연속조회가 끝까지 가도 닿지 않으면 그 시리즈를 버리고 받은 것으로 새로 만든다.
  - 받은 행 중 `confirm_at`이 지나지 않은 행(가장 늦은 행)은 진행 중 구간의 봉으로 떼어 `current`에 둔다. 캐시 구간에는 확정 봉만 들어간다.
- **실시간으로 만든 봉 붙이기**(`append_realtime`)
  - 봉 시작 시각이 `newest`보다 늦어야 한다.
  - 키움 세션이 `newest`의 확정 시각 이전부터 지금까지 한 번도 끊기지 않았어야 한다.
  - 둘 다 맞을 때만 붙인다. 끊겼으면 붙이지 않고 앞으로 늘리기를 예약한다. 이 조건이 없으면 끊긴 동안의 봉이 빠진 채로 구간이 늘어나 불변식이 깨진다.
  - 그 키의 시리즈가 메모리에 없으면 붙이지 않는다. 다음에 열 때 키움에서 받는다.

```rust
pub struct BarPage {
    pub bars: Vec<ConfirmedBar>,      // 오름차순, before 보다 이른 것
    pub current: Option<KiwoomBar>,   // 최신 페이지일 때만. 키움 조회가 준 진행 중 구간의 봉
    pub next_before: Option<KstTime>, // None이면 더 과거가 없다
}

impl BarService {
    /// before가 None이면 최신 페이지다. 요청 범위가 메모리의 캐시 구간 안이면 키움을 부르지 않는다.
    /// 최신 페이지는 언제나 키움 최신 페이지를 한 번 받는다(current를 채우려고).
    pub async fn page(&self, key: SeriesKey, before: Option<KstTime>, limit: usize) -> Result<BarPage, BarError>;
    /// 07:45 타이머가 부른다. 시리즈를 모두 내리고 합치기 범위를 바꾼다.
    pub fn clear_all(&self);
    /// 1분 타이머가 부른다. 10분 동안 요청이 없던 시리즈를 내린다. 조회 중인 시리즈는 남긴다.
    pub fn evict_idle(&self);
}

// #4에서 더한다
//  - BarPage.current를 enum으로: MarketHub 스냅숏의 현재 봉(Live) 또는 키움 조회 값(Fetched).
//  - BarPage.seq: 최신 페이지이고 실시간 집계기가 있을 때만 Some.
//  - refresh_latest(key, prio) -> RefreshResult, append_realtime(key, bar, live_since).
```

- **최신 페이지의 `current`**
  - #4 이후 그 키에 실시간 집계기가 있으면 `MarketHub` 스냅숏의 현재 봉이다.
  - #2·#3, 또는 집계기가 없으면 키움 최신 페이지의 마지막 봉(진행 중 구간)이다(D12). 메모리에 시리즈가 이미 있어도 최신 페이지 요청이면 키움 최신 페이지를 한 번 받아 `current`를 채운다. 같은 응답으로 앞으로 늘리기도 한다.
- **같은 요청은 한 번만**: 같은 `SeriesKey`의 요청은 키별 잠금(`Slot.series`)에서 줄을 선다. 잠금은 키움 조회 동안에도 쥔다.
  - 최신 페이지 요청은 잠금을 기다리기 전에 `latest_fetches`를 읽어 둔다. 잠금을 잡았을 때 값이 바뀌었으면 앞 요청이 그사이 최신 페이지를 받은 것이다. 그러면 키움을 다시 부르지 않고 메모리 결과를 쓴다.
  - 과거 페이지 요청은 잠금을 잡은 뒤 메모리에 `before` 아래로 `limit`개가 있는지 본다. 앞 요청이 이미 받아 두었으면 키움을 부르지 않는다.
  - 그래서 칸 네 개가 같은 종목을 동시에 열어도 키움에는 한 번 간다.

### 6.4 늦은 응답과 출처 교체

키움 조회는 수 초가 걸린다. 그사이 시리즈가 내려가거나(10분 내리기, 07:45 비우기) 다른 쓰기가 끼어들 수 있다(W4-07). 메모리에서는 다음 두 가지로 충분하다.

- **시리즈 세대 번호**(`SeriesId`)
  - 요청은 맵에서 `Slot`(`Arc`)을 받아 쥐고 시작한다. 시리즈가 없으면 요청이 빈 시리즈를 먼저 만든다.
  - 그사이 시리즈가 내려가면(10분 내리기, 07:45 비우기) 맵에서는 빠지고 요청이 쥔 `Slot`만 남는다. 응답은 그 떨어져 나간 `Slot`에 쓰이고 요청이 끝나면 함께 버려진다. 비운 캐시를 늦은 응답이 되살리지 못한다.
  - 요청을 마칠 때 맵의 `Slot.id`가 쥔 것과 다르면 `info` 로그를 남긴다.
  - 응답이 시리즈를 새로 만드는 경로는 없다. 시리즈를 만드는 것은 요청뿐이다.
  - 07:45 비우기는 합치기 범위(`MergeScope`)도 바꾼다. 비우기 전에 출발한 키움 조회의 응답을 비운 뒤의 요청이 나눠 받지 않는다(§4.2).
- **키별 잠금**(#2·#14): 한 시리즈의 읽기와 쓰기는 그 키의 `tokio::Mutex`로 줄 세운다. #2에는 실시간 쓰기가 없어서 키움 조회 동안에도 잠금을 쥔다. 같은 키의 요청을 합치는 일도 이 잠금이 한다(§6.3).
  - #4에서 다시 본다. 실시간으로 만든 봉을 붙이는 쓰기가 키움 조회(수 초)를 기다리면 안 되기 때문이다. 그때는 키움을 기다리는 동안 잠금을 놓고, 응답을 반영할 때만 쥔다. 반영할 때 `SeriesId`를 비교해 다르면 버린다.
- **출처 교체 규칙**
  - 키움에서 받은 봉은 같은 `t`의 봉을 언제나 덮어쓴다(`source = Kiwoom`, `needs_verify = false`).
  - 실시간으로 만든 봉은 같은 `t`에 봉이 이미 있으면 넣지 않는다. 뒤늦게 도착한 실시간 쓰기가 키움 값을 되돌리지 못한다.
- **반영 순서**: 메모리 반영 → `MarketHub`에 알림 → 브라우저에 `reload`.
- **실시간으로 만든 봉이 키움 값으로 바뀌는 때**
  1. 끊긴 구간 복구(§5.2).
  2. 불완전한 봉의 확정 직후(§5.4).
  3. 과거로 늘리거나 앞으로 늘리면서 그 구간을 다시 받을 때(§6.3).
  4. 매일 20:05에 열려 있는 키와 켜진 알림의 키에 대해 `refresh_latest(Background)`. 그날 실시간으로 만든 봉을 그날 안에 정리한다.
- 교체된 봉이 브라우저가 이미 받은 봉이면 `reload { reason: "replaced", from }`으로 알린다.

### 6.5 조회 범위

- **처음 열 때**: 최근 500봉(`limit` 기본 500). 한 페이지에 일봉 600, 분봉 900, 주봉 300, 월봉 240개가 온다(kiwoom.md §1). 그래서 일봉과 분봉은 1회, 주봉은 2회, 월봉은 3회 조회한다.
- **과거로 스크롤**: 브라우저가 `before` 커서로 다음 500봉을 요청한다. 메모리의 캐시 구간 안이면 바로, 밖이면 키움에서 받아 구간을 늘린다.
- **분봉은 최근 1년만**(U1, ADR 0003, #14)
  - 하한은 키움이 정한다. 키움은 분봉을 마지막 관측일로부터 1년까지 주고, 거기서 `cont-yn: N`으로 연속조회를 끝낸다(kiwoom.md 2절: `_AL`·KRX·지수 모두 2025-11-03에서 끝남. 13절: `_NX`도 같은 날). 서버는 따로 날짜를 계산하지 않고 이 끝을 `reached_origin`으로 받는다. 그 지점에서 `nextBefore = null`이다.
  - U1의 "캐시에 더 오래된 분봉이 있어도 돌려주지 않는다"는 따로 할 일이 없다. 캐시는 메모리에만 있고 매일 07:45에 비우므로, 키움이 주지 않는 분봉을 가질 수 없다.
  - 거래소마다 하루 봉 수가 달라 1년의 페이지 수도 다르다. 1분봉은 `_AL` 191페이지, KRX 115페이지다. 60분봉은 3~4페이지다.
  - 일·주·월봉에는 하한이 없다. 일봉은 1985년까지 받을 수 있다. NXT는 2025-03부터만 있어서 `_NX` 일·주·월봉은 거기서 끝난다.
- **지표 알림**: 알림이 잡은 키는 지표 계산에 필요한 N개(§7.3)를 서버가 미리 채운다. 서버를 켤 때와 07:45 비우기 뒤에도 다시 채운다.

### 6.6 종목 목록과 검색

> 켜지는 단계: #2

**목록 받기**: 종목 목록도 메모리에만 둔다. 서버를 켤 때와 매일 07:45에 ka10099를 두 번(`mrkt_tp=0`, `10`) 불러 목록을 통째로 바꾼다. 실측에서는 각 호출이 연속조회 없이 한 번에 왔다. 코드는 `cont-yn: Y`가 오면 호출마다 10페이지까지 따라간다.

- 서버를 켤 때는 `Screen` 우선순위로 받는다. 받기 전에 온 검색·봉 요청은 목록이 올 때까지 기다린다(`READY_WAIT` 10초, 넘으면 `kiwoom_unavailable`). 그래서 서버는 목록을 받기 전에 요청을 받기 시작한다(§4.1 켜는 순서).
- 07:45 갱신은 `Background`로 받는다. 받는 동안과 실패했을 때는 이전 목록을 그대로 쓴다. 실패하면 5분마다, 다음 07:45 전까지 다시 시도한다.
- 서버를 켤 때 받기에 실패하면 10초 간격으로 다시 시도한다. 그동안 검색과 봉 요청은 `kiwoom_unavailable`이다.

| 호출 | 행의 `marketCode` | 넣는가 | `kind` | `market` |
|---|---|---|---|---|
| `mrkt_tp=0` | `0`(거래소) | 넣는다 | 코드 끝자리가 `0`이면 `common`, 아니면 `preferred` | `kospi` |
| | `8`(ETF) | 넣는다 | `etf` | `kospi` |
| | `6`(리츠) | 넣는다 | `reit` | `kospi` |
| | `60`·`70`·`90`(ETN), `2`(인프라투자금융), `4`(뮤추얼펀드), 그 밖 | 넣지 않는다 | — | — |
| `mrkt_tp=10` | `10` | 넣는다 | 코드 끝자리가 `0`이면 `common`, 아니면 `preferred` | `kosdaq` |

- `mrkt_tp=0`은 "코스피 주식"이 아니라 거래소 시장의 모든 상품이다. 그래서 `marketCode`로 거른다(kiwoom.md §5). 모르는 `marketCode`는 넣지 않고 `warn` 로그를 남긴다. 제외 상품을 `common`으로 뭉개지 않는다.
- 우선주는 이름이 아니라 **코드 끝자리**로 가린다. 이름 규칙은 코스닥에서 오탐을 낸다(에코글로우, 이오플로우, 성우). 끝자리는 글자일 수도 있다(`03481K`).
- 스팩은 코스닥 보통주로 둔다. #2 범위("주식")에 들기 때문이다. 가리는 규칙은 kiwoom.md §5에 있다.
- 코스피·코스닥 지수 두 개(`IDX:001` 코스피, `IDX:101` 코스닥)는 코드에 고정해서 넣는다.
- 목록에 없는 종목코드로 봉을 요청하면 `unknown_symbol`이다.
- **NXT 가능 여부**: 행의 `nxtEnable`이 `"Y"`이면 `nxt_enabled = true`다. 지수 두 개는 `false`다. 2026-11-09 기준 주식 2,744개 중 603개(22%)가 NXT 가능이다(kiwoom.md 12.4). 이 값은 종목 목록과 함께 매일 07:45에 바뀐다.

**검색**(D5, D12): 메모리에서 한다.

1. **정규화**: 앞뒤 공백을 자르고, 안쪽 공백을 지우고, 영문은 대문자로 바꾼다. 종목명도 같은 정규화를 거친 값과 비교한다. 정규화한 입력이 비면 `[]`를 돌려준다.
2. **초성 검색**: 정규화한 입력이 모두 한글 자음(ㄱ~ㅎ)일 때만 쓴다. 종목명의 초성열과 비교한다. 초성열은 목록을 받을 때 만든다.
3. **순위**: 코드 완전 일치 > 이름 완전 일치 > 코드 접두 > 이름 접두 > 초성 접두 > 이름 포함 > 초성 포함.
4. **같은 순위 안**: 지수 > 보통주 > 우선주 > ETF > 리츠 순서. 그다음 이름 순서다.
5. **이름 순서**: 정규화한 이름을 글자 단위로 앞에서부터 비교한다. 글자의 종류 순서는 한글 음절 < 라틴 문자 < 숫자 < 그 밖이다. 같은 종류 안에서는 한글은 가나다순(유니코드 음절 순서), 라틴 문자는 알파벳순이다. 그래서 `삼성전자`가 `삼성SDI`보다 앞이다. 앞 글자가 모두 같으면 짧은 이름이 앞이다.
6. **개수**: 최대 20개.

---

## 7. 사용자 자료 스키마

> 켜지는 단계: #3(SQLite 파일, 관심종목, 레이아웃 기본 1칸, `ui_state`), #6(드로잉), #7(여러 칸), #8(알림)

SQLite 파일 하나(`data/vally.db`, git 제외)에 둔다(ADR 0006). sqlx의 `sqlite` 기능으로 열고, 마이그레이션은 sqlx 마이그레이션(`migrations/`)으로 한다. 사용자는 한 명뿐이라 사용자 id 열이 없다(ADR 0001).

- id는 브라우저가 만드는 UUID(v7) 문자열이다. `TEXT`로 저장한다. 그래서 생성과 수정이 모두 `PUT /…/:id`(upsert, `INSERT … ON CONFLICT(id) DO UPDATE`)다. 자동 저장을 몇 번 다시 보내도 결과가 같다.
- 시각은 `INTEGER`(Unix 초)다. 브라우저 계약의 `UnixSeconds`와 같은 값이다.
- JSON 열은 JSON 텍스트(`TEXT`)이고 `CHECK (json_valid(…))`를 건다. 서버가 받을 때 크기(64KB)만 검사하고 그대로 저장한다. 모양은 프런트엔드가 정한다. 모르는 키도 버리지 않고 그대로 돌려준다. 서버가 해석해야 하는 것(드로잉 점, 알림 조건)은 별도 열로 두고 파싱해서 검사한다.
- 참/거짓은 `INTEGER` 0·1이다(`CHECK (x IN (0,1))`).

### 7.1 연결

```rust
pub struct AppDb {
    /// 읽기 풀. 크기 4.
    read: SqlitePool,
    /// 쓰기 풀. 크기 1. 모든 쓰기가 이 연결 하나로 줄 선다.
    write: SqlitePool,
}

impl AppDb {
    /// 파일과 상위 디렉터리가 없으면 만든다. 열고 나서 마이그레이션을 돌린다.
    pub async fn open(path: &Path) -> Result<AppDb, DbError>;
}
```

- **파일**: `VALLY_DB_PATH`(§11.1). 기본 `data/vally.db`(서버 작업 디렉터리 기준). `data/`가 없으면 만든다. 파일이 없으면 만든다(`create_if_missing`).
- **연결마다 거는 설정**(sqlx `SqliteConnectOptions`)
  - `journal_mode = WAL`: 쓰는 동안에도 읽기가 막히지 않는다.
  - `foreign_keys = ON`: SQLite는 연결마다 꺼진 채로 시작하므로 모든 연결에 건다. `ON DELETE CASCADE`가 이것에 기댄다.
  - `busy_timeout = 5000`(5초): 잠금을 기다리다 곧바로 `SQLITE_BUSY`로 실패하지 않게 한다.
  - `synchronous = NORMAL`: WAL에서 권장되는 값이다. 전원이 나가면 마지막 몇 개의 커밋을 잃을 수 있지만 파일은 깨지지 않는다. 자동 저장 자료라 받아들인다.
- **풀 크기**: 쓰기 풀 1, 읽기 풀 4(읽기 전용 연결). SQLite는 쓰는 사람이 한 번에 하나뿐이다. 쓰기 연결을 하나로 두면 쓰기끼리 `SQLITE_BUSY`로 부딪히지 않는다. 쓰기는 자동 저장으로 1초에 한 번 정도라 충분하다.
- **트랜잭션**: 쓰기 트랜잭션은 `BEGIN IMMEDIATE`로 연다. 레이아웃과 칸처럼 여러 테이블을 함께 바꾸는 쓰기는 한 트랜잭션이다.
- **백업**: 파일 복사로 한다. 서버가 켜져 있을 때는 `VACUUM INTO 'data/backup-YYYYMMDD.db'`로 한다(WAL 파일까지 일관되게 담긴다). 자동 백업은 v1에 두지 않는다.
- 서버 하나 보장은 잠금 파일이 맡는다(§4.1). 그래서 같은 DB 파일을 두 서버가 여는 일은 없다.

### 7.2 테이블

```sql
-- 관심종목: 목록 하나
CREATE TABLE watchlist (
  symbol   TEXT    PRIMARY KEY,
  position INTEGER NOT NULL UNIQUE
) STRICT;

-- 관심종목의 저장 순서 번호(0002). 목록이 여러 행이라 한 행짜리 표에 둔다
CREATE TABLE watchlist_revision (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  revision  INTEGER NOT NULL
) STRICT;

-- 레이아웃
CREATE TABLE layouts (
  id          TEXT    PRIMARY KEY,                     -- UUID v7
  name        TEXT    NOT NULL UNIQUE,
  arrangement TEXT    NOT NULL CHECK (arrangement IN ('1','2h','2v','3','4')),
  sync        TEXT    NOT NULL CHECK (json_valid(sync)),  -- { crosshair: bool, scroll: bool }. 빠진 키는 true로 읽는다
  position    INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,                        -- Unix 초
  revision    INTEGER NOT NULL DEFAULT 0               -- 저장 순서 번호(0002, §8.2 "저장 순서")
) STRICT;

CREATE TABLE layout_cells (
  layout_id      TEXT    NOT NULL REFERENCES layouts(id) ON DELETE CASCADE,
  slot           INTEGER NOT NULL CHECK (slot BETWEEN 0 AND 3),
  symbol         TEXT    NOT NULL,
  venue          TEXT    CHECK (venue IN ('combined','krx','nxt')),  -- 거래소(ADR 0007). 지수면 NULL
  period         TEXT    NOT NULL,
  symbol_link    INTEGER NOT NULL CHECK (symbol_link IN (0,1)),   -- 종목 연동
  chart_settings TEXT    NOT NULL CHECK (json_valid(chart_settings)),  -- 지표·기간·축·비교 종목. 프런트엔드 소유
  PRIMARY KEY (layout_id, slot),
  CHECK ((symbol LIKE 'IDX:%') = (venue IS NULL))   -- 지수에는 거래소가 없고, 주식에는 언제나 있다. 두 비교식은 0·1 정수라 `=`로 견준다
) STRICT;
-- 칸 개수와 arrangement가 맞는지는 서버가 쓰기 전에 검사한다('1'→1칸, '2h'/'2v'→2칸, '3'→3칸, '4'→4칸).
-- 칸의 거래소가 그 종목에 허용되는지(NXT 불가 종목의 'nxt')는 서버가 쓰기 전에 종목 목록으로 검사한다.

-- 마지막으로 연 레이아웃, 테마 같은 화면 상태. 64KB 이하. 모르는 키도 그대로 저장한다.
CREATE TABLE ui_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  state     TEXT    NOT NULL CHECK (json_valid(state)),   -- revision 키는 빼고 저장한다
  revision  INTEGER NOT NULL DEFAULT 0                    -- 저장 순서 번호(0002)
) STRICT;

-- 드로잉: 종목에 붙는다. 거래소, 봉 주기, 레이아웃에는 붙지 않는다(ADR 0007).
CREATE TABLE drawings (
  id         TEXT    PRIMARY KEY,
  symbol     TEXT    NOT NULL,
  tool       TEXT    NOT NULL CHECK (tool IN ('trendline','hline','vline','rect','fib','text')),
  points     TEXT    NOT NULL CHECK (json_valid(points)),   -- [{ t: Unix 초, price: number }]
  text       TEXT,
  style      TEXT    NOT NULL CHECK (json_valid(style)),
  updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX drawings_by_symbol ON drawings (symbol);

-- 알림
CREATE TABLE alerts (
  id          TEXT    PRIMARY KEY,
  symbol      TEXT    NOT NULL,
  condition   TEXT    NOT NULL CHECK (json_valid(condition)),  -- AlertCondition(§8.2). 서버가 파싱한다
  repeat      TEXT    NOT NULL CHECK (repeat IN ('once','every')),
  enabled     INTEGER NOT NULL CHECK (enabled IN (0,1)),
  channels    TEXT    NOT NULL CHECK (json_valid(channels)),   -- JSON 배열: ["telegram","in_app"]
  note        TEXT,
  updated_at  INTEGER NOT NULL
) STRICT;

CREATE TABLE alert_events (
  id          INTEGER PRIMARY KEY,                    -- rowid. 자동으로 는다
  alert_id    TEXT    NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
  kind        TEXT    NOT NULL CHECK (kind IN ('price','indicator')),
  fired_at    INTEGER NOT NULL,                       -- Unix 초
  bar_t       INTEGER NOT NULL,       -- 판단에 쓴 봉의 시작 시각(가격 알림은 체결이 속한 1분 구간 시작)
  bar_source  TEXT    NOT NULL CHECK (bar_source IN ('realtime','kiwoom')),  -- BarSource 직렬화 이름
  message     TEXT    NOT NULL,
  delivered   TEXT    NOT NULL CHECK (json_valid(delivered))  -- 채널별 성공/실패
) STRICT;
CREATE INDEX alert_events_by_time ON alert_events (fired_at DESC);
-- 지표 알림만 (alert_id, bar_t) 중복을 막는다(D9). 가격 알림은 같은 1분 안에 여러 번 울릴 수 있다(every).
-- SQLite도 부분 인덱스를 지원한다.
CREATE UNIQUE INDEX alert_events_once_per_bar ON alert_events (alert_id, bar_t)
  WHERE kind = 'indicator';
```

- `STRICT` 테이블이라 열 타입이 어긋난 값은 들어가지 않는다.
- 첫 마이그레이션이 "기본" 레이아웃 하나를 넣는다(1칸, 코스피 지수 일봉, `venue` NULL, `sync` 둘 다 `true`). #3은 처음부터 `venue` 열이 있는 형식으로 시작한다(D17). #3에서 차트 설정 자동 저장은 이 레이아웃의 칸을 고치는 것이다. 레이아웃이 0개인 상태는 없다. 마지막 레이아웃은 지울 수 없다.
- 드로잉 점 개수는 도구마다 고정이다: 추세선 2, 수평선 1, 수직선 1, 사각형 2, 피보나치 되돌림 2, 텍스트 1. 서버가 검사한다.
- 드로잉 점의 가격은 0.01 단위 정수가 아니라 실수다. 드로잉은 봉 가격이 아닌 아무 가격에나 놓을 수 있다.
- 중복 금지 인덱스에 걸리면(`SQLITE_CONSTRAINT_UNIQUE`) 이미 울린 것이므로 보내지 않는다(§7.3).

### 7.3 알림의 타입과 판단

```rust
pub enum AlertCondition {
    Price { op: PriceOp, target: Price },
    Indicator { period: Period, rule: IndicatorRule },
}
pub enum PriceOp { Gte, Lte }

pub enum IndicatorRule {
    /// 지표 선 하나가 값을 돌파.
    CrossValue { line: LineRef, dir: CrossDir, value: f64 },
    /// 두 지표 선의 교차.
    CrossLine { a: LineRef, b: LineRef, dir: CrossDir },
}
pub struct LineRef { pub spec: indicators::Spec, pub line: indicators::LineId }
pub enum CrossDir { Up, Down }
pub enum Repeat { Once, Every }
```

**서버가 알림을 받을 때 하는 검사**(D6, D8). 틀리면 `bad_request`와 한국어 `message`를 돌려준다.

- `spec`이 `Spec::validate`를 통과해야 한다.
- `line`이 그 `spec`의 출력 선이어야 한다. 이동평균 지표에 `rsi` 선을 고르면 거절한다. 예: "이동평균 지표에는 'rsi' 선이 없습니다."
- 이동량이 0이 아닌 선은 거절한다. 일목 선행스팬 A·B(`spanA`, `spanB`)와 후행스팬(`lagging`)이 그렇다. 예: "이동된 선(선행스팬·후행스팬)은 알림에 쓸 수 없습니다."

**`domain::alert`의 판단 함수(순수)**

```rust
/// 가격 알림(U2). 직전 기준 가격에서 target을 "새로 넘어설 때"만 true.
pub struct PriceArm { reference: Option<Price> }

impl PriceArm {
    /// 만들거나 다시 켤 때 그 순간의 현재가로 시작한다. 현재가를 모르면 None.
    pub fn new(reference: Option<Price>) -> Self;
}

/// 체결마다 부른다. Gte: reference < target 이고 trade.price ≥ target 이면 true. Lte는 반대.
/// 결과와 무관하게 reference = trade.price 로 바꾼다. reference가 None이면 기준만 정하고 false.
pub fn judge_price(arm: &mut PriceArm, op: PriceOp, target: Price, trade: &Trade) -> bool;

/// 지표 알림. 봉이 확정될 때만 부른다. 직전 확정 봉과 이번 확정 봉의 값을 받는다.
/// Up: prev_a ≤ prev_b 이고 cur_a > cur_b. 값 중 하나라도 NaN이면 false.
pub fn judge_cross(dir: CrossDir, prev: (f64, f64), cur: (f64, f64)) -> bool;
```

**가격 알림**(U2)

- 가격이 정한 값을 **새로 넘어설 때** 울린다. `gte`이면 직전 기준 가격이 `target` 미만이었다가 `target` 이상인 체결이 들어올 때 울린다. `lte`는 그 반대다.
- 직전 기준 가격은 알림을 만들거나 다시 켠 순간 서버가 아는 현재가에서 시작한다. 그래서 만들 때 이미 넘어 있으면, 반대편으로 갔다가 다시 넘어올 때까지 울리지 않는다.
- 서버가 그 순간의 현재가를 모르면(그 종목을 아직 받지 않았으면) 다음 첫 체결을 기준으로 삼고, 그 체결로는 울리지 않는다.
- 서버를 다시 켜도 마찬가지다. 기준 가격은 저장하지 않는다. 다시 켠 뒤 첫 체결이 기준이 된다. 그래서 서버가 꺼져 있던 동안 넘어선 것으로는 울리지 않는다.
- 서버가 지금 쥔 기준 가격은 `Alert.priceReference`(읽기 전용)로 브라우저에 보인다.
- 기록의 `bar_t`는 그 체결이 속한 1분 구간의 시작, `bar_source`는 `realtime`이다. 가격 알림은 체결로 판단하므로 언제나 실시간이다.

**지표 알림**(D7, D9)

- 그 `(종목, 봉 주기)`에서 봉이 확정될 때마다 판단한다.
- **입력**: 가장 최근 N개의 확정 봉으로 지표를 **처음부터 다시 계산**한다(`indicators::compute`). N = max(`spec.warmup()` × 4, 500). 두 선을 비교하면 두 spec 중 큰 warmup을 쓴다. 서버는 이전 계산 상태를 이어 가지 않는다. 그래서 재시작해도 같은 입력이면 같은 결과다.
- **화면과의 차이**: 화면은 불러온 봉 전체로 계산한다. 그래서 EMA 계열(EMA, MACD, RSI) 값이 알림 값과 아주 조금 다를 수 있다.
- **실시간으로 만든 봉으로 바로**: 실시간으로 만든 확정 봉으로 바로 판단해 알린다. 단, `needs_verify` 봉은 키움 값으로 바뀐 뒤에 처음 판단한다(§5.4).
- **기록**: 울릴 때마다 (알림 id, 봉 시작 시각 `bar_t`, 봉 출처)를 `alert_events`에 남긴다.
- **중복 금지**: 같은 (알림, `bar_t`)로는 두 번 울리지 않는다. 부분 유일 인덱스가 막는다. 기록을 먼저 넣고 성공했을 때만 보낸다.
- **소급 없음**: 나중에 봉 출처가 바뀌거나, 끊긴 구간을 메우거나, 재시작해도 정정하거나 다시 울리지 않는다.

**공통**

- `Once`: 한 번 울리면 `enabled = false`로 저장한다.
- `Every`: 가격 알림은 반대편으로 갔다가 다시 넘어설 때 또 울린다. 지표 알림은 교차가 다시 일어날 때 울린다.
- 켜진 알림의 종목은 `Holder::Alert`로 구독을 잡는다. 지표 알림은 그 `(종목, 봉 주기)` 집계기도 연다.
- **거래소**: 알림에는 거래소 열이 없다. 가격 알림과 지표 알림 모두 통합 시세로 판단한다(ADR 0007의 기본). 거래소별 알림이 필요해지면 `alerts`에 `venue` 열을 더한다.

---

## 8. 브라우저 계약

프런트엔드는 이 절만 보고 데이터 계층을 짤 수 있다. 위의 내부 설계는 몰라도 된다. 각 항목 옆의 `(#N)`은 그 기능이 켜지는 이슈다(§0).

### 8.1 공통 규칙

- 서버 주소는 같은 출처다. REST는 `/api/…`, WebSocket은 `/api/ws`. 로그인은 없다.
- 시각 `t`는 **Unix 초(UTC 기준 정수)** 다. 봉의 `t`는 봉 시작 시각이다.
  - KST로 보여 주는 것은 브라우저 일이다. Lightweight Charts는 UTC로 표시하므로 표시용으로 `t + 32400`을 넘기는 방법이 흔하다.
  - 저장·전송하는 값은 언제나 원래 `t`다. 드로잉 점을 저장할 때 표시용 값을 되돌리는 것을 잊지 않는다.
- 봉 시작 시각 규칙: 분봉은 정시 기준 n분 경계, 일봉은 그 날짜 00:00 KST, 주봉은 그 주 월요일 00:00 KST, 월봉은 1일 00:00 KST(1일이 주말이어도).
- 분봉은 **최근 1년만** 온다(#14). 과거로 받다가 `nextBefore`가 `null`이 되면 끝이다. 프런트는 "분봉은 최근 1년까지" 안내를 띄운다.
- **거래소**(#14, ADR 0007): 주식은 칸마다 `combined`(통합, 기본), `krx`, `nxt` 중 하나를 고른다. 지수에는 거래소가 없다(`null`). 봉은 그 거래소의 봉이다. 같은 날 같은 종목도 거래소마다 종가가 다르다. 예: 005930 일봉 2026-11-06 종가는 통합 193,400, KRX 193,500, NXT 193,400이다(kiwoom.md 3·12절).
- 가격은 자연 단위의 `number`다(주식 원, 지수 포인트). 주식은 정수, 지수는 소수 둘째 자리까지다.
- 거래량은 `number`(정수)다. 지수의 거래량 단위는 아직 확인하지 못했다. 받은 값을 그대로 보여 준다.
- 오류 응답은 HTTP 4xx/5xx와 본문 `ApiError`다. 코드마다 HTTP 상태가 하나다(`http::status_of`).

| `code` | HTTP | 뜻 |
|---|---|---|
| `bad_request` | 400 | 질의나 본문이 틀렸다 |
| `not_found` | 404 | 없는 API 경로, 없는 사용자 자료 |
| `unknown_symbol` | 404 | 종목 목록에 없거나 키움이 빈 행을 준 종목 |
| `conflict` | 409 | 마지막 레이아웃 지우기 같은 충돌 |
| `stale_revision` | 409 | 사용자 자료 PUT의 `revision`이 저장된 것보다 크지 않다. 더 새 편집이 이미 저장돼 있어 저장하지 않았다(§8.2 "저장 순서") |
| `payload_too_large` | 413 | 한도를 넘는 본문. 화면 상태·관심종목 64KB, 칸 하나의 `chartSettings` 64KB, 레이아웃 본문 272KB(4 × 64KB + 16KB) |
| `method_not_allowed` | 405 | 있는 API 경로에 틀린 메서드를 보냈다(`POST /api/ui-state` 등) |
| `internal` | 500 | 서버 버그(파싱 실패, 키움이 거절한 요청) |
| `kiwoom_auth_failed` | 502 | 키움이 우리 인증을 거절했다. 다시 시도해도 낫지 않는다. 운영자가 설정을 고친다 |
| `kiwoom_unavailable` | 503 | 키움에 닿지 못했거나 요청 개수 초과가 이어졌거나 종목 목록을 아직 못 받았다. 다시 시도할 수 있다 |

```ts
type UnixSeconds = number;
type SymbolCode = string; // 주식·ETF "005930", 지수 "IDX:001"(코스피) "IDX:101"(코스닥)
type Period = "1m" | "3m" | "5m" | "15m" | "30m" | "60m" | "D" | "W" | "M";
type Venue = "combined" | "krx" | "nxt";   // 거래소. 주식에만 있다
type Uuid = string;       // 브라우저가 만드는 UUID v7
type BarSource = "realtime" | "kiwoom";   // 봉 출처. 백엔드 BarSource의 직렬화 이름

interface Bar {
  t: UnixSeconds; // 봉 시작 시각
  o: number; h: number; l: number; c: number;
  v: number;
}

interface ApiError {
  error: {
    code:
      | "bad_request" | "not_found" | "unknown_symbol"
      | "kiwoom_unavailable"  // 키움 조회 실패(네트워크, 5xx, 요청 개수 초과 반복)
      | "kiwoom_auth_failed"  // 운영자가 고쳐야 한다
      | "conflict" | "stale_revision" | "payload_too_large" | "method_not_allowed" | "internal";
    message: string;          // 사람이 읽는 한국어 문장
  };
}
```

### 8.2 REST

#### 종목 (#2)

```ts
// GET /api/symbols?q=삼성
// 서버 규칙(§6.6과 같다):
//  - 정규화: 앞뒤 공백 자르기, 안쪽 공백 지우기, 영문 대문자. 정규화한 q가 비면 []
//  - q가 모두 한글 자음(ㄱ~ㅎ)이면 초성 검색
//  - 순위: 코드 완전 일치 > 이름 완전 일치 > 코드 접두 > 이름 접두 > 초성 접두 > 이름 포함 > 초성 포함
//  - 같은 순위: 지수 > 보통주 > 우선주 > ETF > 리츠, 그다음 이름 순서
//  - 이름 순서: 글자 단위 비교. 한글 음절 < 라틴 문자 < 숫자 < 그 밖. 한글은 가나다순, 라틴은 알파벳순
//    (예: "삼성전자" < "삼성SDI")
//  - 최대 20개
// 빈 입력일 때 화면(관심종목과 최근 본 종목)은 브라우저가 만든다. 서버를 부르지 않는다.
// 서버를 막 켜서 종목 목록을 아직 못 받았으면 최대 10초 기다린 뒤 503 kiwoom_unavailable.
type SymbolSearchResponse = SymbolInfo[];

// GET /api/symbols/:code     → SymbolInfo. 없으면 404 unknown_symbol
interface SymbolInfo {
  code: SymbolCode;
  name: string;
  kind: "index" | "common" | "preferred" | "etf" | "reit";
  market: "kospi" | "kosdaq";
  nxtEnabled: boolean;   // NXT를 고를 수 있는가(ka10099 nxtEnable). 지수는 false
}
```

#### 봉 (#2, `venue`와 분봉은 #14, `seq`는 #4)

```ts
// GET /api/bars?symbol=005930&venue=krx&period=5m&limit=500[&before=1730000000]
// before 없음: 최신 페이지. current와 seq 포함.
// before 있음: t < before 인 확정 봉 중 최신 limit개. current와 seq는 null.
// limit 기본 500, 최대 1000. 키움 조회를 기다리면 수 초 걸릴 수 있다.
// venue: 주식에서 빼면 combined. 지수에 주거나 모르는 값이면 400 bad_request.
//        nxtEnabled가 false인 종목에 nxt를 주면 400 bad_request(키움에 보내지 않는다).
interface BarsPage {
  symbol: SymbolCode;
  venue: Venue | null;             // 이 페이지의 거래소. 지수면 null
  period: Period;
  bars: Bar[];                     // 확정 봉, t 오름차순
  current: Bar | null;             // 최신 페이지일 때만. 진행 중 구간의 봉
  nextBefore: UnixSeconds | null;  // 더 과거를 받을 커서. null이면 끝(분봉은 1년 하한)
  seq: number | null;              // 이 스냅숏이 반영한 마지막 seq. #2·#3, 과거 페이지, 실시간이 없는 키는 null
}
```

- 과거로 스크롤할 때는 받은 `nextBefore`를 그대로 `before`에 넣는다. `venue`도 최신 페이지와 같은 값을 넣는다.
- **NXT 불가 종목의 `nxt`를 거절하는 이유**: 키움은 그런 `_NX` 요청에 "없는 종목"과 같은 빈 행을 준다(kiwoom.md 13절). 보내면 `unknown_symbol`과 구별할 수 없다.
- **분봉**(#14): 봉의 `t`는 구간 시작 KST다(키움 `cntr_tm`). 한 페이지 900봉이라 최신 500봉은 키움 1회 조회다. 진행 중 구간은 `current`(키움 조회 스냅숏)로 온다. 저절로 바뀌지 않는다. 실시간 현재 봉은 #4다.
- **정규장 종가**: 계약에 없다(D17, 2026-11-09 사용자 결정). `Bar`에 `rc` 같은 필드를 두지 않는다. KRX 일봉 종가도 2026-09-14부터는 애프터마켓의 마지막 체결가다.
- **#2·#3의 최신 페이지**(D3, D12): `current`는 키움 조회가 준 오늘(이번 주, 이번 달) 봉, 즉 진행 중 구간이다. 저절로 바뀌지 않는다. 종목이나 봉 주기를 바꾸거나 새로고침할 때만 새로 받는다. `seq`는 `null`이다.
- **#4 이후의 `current`**: 서버가 체결로 만든 현재 봉의 스냅숏이다.
- **서버를 다시 켜면**: 서버에는 시세 캐시가 남지 않는다. 첫 요청은 키움에서 받으므로 1~3초 걸릴 수 있다. 키움이 응답하지 않으면 `503 kiwoom_unavailable`이다.
- **과거 페이지 합치기**: 과거 페이지는 확정 봉만 담는다. 이미 가진 봉보다 늦은 `t`의 봉을 덮어쓰지 않는다.

#### 현재가 (#3)

```ts
// GET /api/quotes?symbols=005930,000660,IDX:001
// 관심종목을 처음 그릴 때 쓴다. #4부터는 이후 갱신이 WebSocket quotes 메시지로 온다.
type QuotesResponse = Quote[];

interface Quote {
  symbol: SymbolCode;
  price: number;        // 현재가
  change: number;       // 현재가 − 기준가(보통 전일 종가). 부호 있음
  changeRate: number;   // %, 부호 있음 (예: -1.23)
  volume: number;       // 당일 누적
  t: UnixSeconds;       // 이 값의 시각
  source: "realtime" | "polled";
}
```

- `symbols`를 빼거나 비우면 `[]`이다. 201개 이상이거나 형식이 틀린 코드가 있으면 400 `bad_request`다. 중복은 한 번만 답한다.
- 응답은 요청 순서다. 값을 얻지 못한 종목(없는 코드, 키움이 빈 행을 준 종목)은 빠진다. `unknown_symbol`을 내지 않는다.
- **주식**: ka10095 통합(`_AL`) 시세다. 칸의 거래소와 상관없다. 100개씩 나눠 보낸다(101개는 1634로 거절, kiwoom.md §10.6). 등락은 §4.6 "현재가의 등락"을 따른다. `t`는 응답의 `dt`·`cntr_tm`(KST)이다.
- **지수**: ka10095는 지수를 받지 않는다. 지수 일봉 최신 페이지(§6)에서 만든다. 현재가는 마지막 봉(진행 중 봉이 있으면 그것)의 종가, 기준가는 그 앞 확정 봉의 종가다. `volume`과 `t`는 마지막 봉의 거래량과 시작 시각이다. 봉이 둘 없으면 빠진다.
- #3의 `source`는 언제나 `polled`다.

#### 저장 순서 (#3, R2)

관심종목, 레이아웃, 화면 상태의 PUT은 본문에 `revision: number`(저장 순서 번호)를 싣는다. 브라우저가 보낼 때마다 `max(Date.now(), 지금까지 쓴 것 + 1)`로 늘린다.

- 서버는 저장된 것보다 **큰** revision만 받는다. 같거나 작으면 409 `stale_revision`이고 아무것도 바꾸지 않는다. 확인과 쓰기는 한 쓰기 트랜잭션(`BEGIN IMMEDIATE`)이다.
- 그래서 늦게 도착한 옛 요청이 새 요청을 덮지 못한다. 브라우저는 앞 요청이 진행 중이어도 탭이 숨을 때 최신 편집을 곧바로 보낼 수 있다(frontend.md §3.7).
- GET은 저장된 revision을 돌려준다. 처음은 0이다. 새 레이아웃 id는 어떤 revision이든 받는다.
- 다른 탭·기기 사이에서는 revision(편집 시각에 가깝다)이 큰 쪽이 이긴다. 기기 시계가 몇 초 늦으면 그 기기의 편집이 그 사이 다른 기기의 편집에 밀릴 수 있다. 탭 사이 동기화는 #4(`data_changed`)다.

#### 관심종목 (#3)

```ts
// GET /api/watchlist
type WatchlistResponse = { symbols: SymbolCode[]; revision: number };   // 표시 순서대로

// PUT /api/watchlist         본문: { symbols: SymbolCode[]; revision: number }
// 목록 전체를 바꾼다. 추가·삭제·순서 바꾸기 모두 이것 하나로 한다. 중복은 400.
// 형식만 맞으면 종목 목록에 없는 코드도 받는다(상장폐지 종목). 화면은 "찾을 수 없음"으로 보여 준다.
// 응답: WatchlistResponse
```

#### 레이아웃 (#3: 기본 1칸만, #7: 여러 칸·여러 레이아웃)

```ts
interface LayoutSummary { id: Uuid; name: string; arrangement: Arrangement; updatedAt: UnixSeconds }

interface Layout {
  id: Uuid;
  name: string;
  arrangement: Arrangement;
  sync: { crosshair: boolean; scroll: boolean };  // 둘 다 기본 true. 저장된 값에 빠져 있으면 true로 읽는다
  cells: Cell[];                  // 길이는 arrangement 칸 수와 같다. slot 0부터
  updatedAt: UnixSeconds;
  revision: number;               // 저장 순서 번호(위 "저장 순서")
}
type Arrangement = "1" | "2h" | "2v" | "3" | "4";   // 2h 좌우, 2v 상하

interface Cell {
  slot: 0 | 1 | 2 | 3;
  symbol: SymbolCode;
  venue: Venue | null;           // 거래소(ADR 0007). 지수면 null, 주식이면 언제나 값이 있다. 기본 combined
  period: Period;
  symbolLink: boolean;           // 종목 연동
  chartSettings: unknown;        // 프런트엔드가 모양을 정한다. 64KB 이하. 서버는 그대로 저장
}

// GET    /api/layouts               → LayoutSummary[] (표시 순서)
// GET    /api/layouts/:id           → Layout
// PUT    /api/layouts/:id           본문: Omit<Layout, "updatedAt">  → Layout   (없으면 만들고 있으면 바꾼다)
// DELETE /api/layouts/:id           → 204. 마지막 레이아웃이면 409 conflict
// "새 레이아웃으로 복제"는 브라우저가 새 id로 PUT 한다.
```

- **PUT 검사**: 다음은 모두 400 `bad_request`다.
  - 주소의 id와 본문의 `id`가 다르다.
  - 이름이 비었다.
  - 칸 수가 `arrangement`와 다르거나 slot이 0부터 n−1까지 하나씩이 아니다.
  - 지수 칸에 거래소가 있거나 주식 칸에 거래소가 없다.
  - `nxtEnabled`가 false인 종목에 `nxt`를 줬다.
- 같은 이름의 다른 레이아웃이 있으면 409 `conflict`다. 없는 id의 GET·DELETE는 404 `not_found`다.
- 종목 목록에 없는 주식은 막지 않는다(상장폐지 종목을 연 칸).
- `nxt` 칸이 있을 때만 종목 목록을 기다린다(최대 10초, 넘으면 503). 그래서 서버를 막 켰을 때도 `nxt`가 없는 자동 저장은 바로 된다.
- `updatedAt`은 서버 시각이다. 응답의 `cells`는 slot 순서다. 새 레이아웃은 목록의 맨 끝에 놓인다.

코드에서 `pane`은 Lightweight Charts의 패널만 뜻한다. 칸은 `cell`이다.

`chartSettings` 안에 지표를 넣을 때는 아래 `IndicatorSpec`을 쓰기를 권한다. 알림을 만들 때 같은 값을 그대로 넘길 수 있다.

#### 화면 상태 (#3)

```ts
// GET /api/ui-state                 → UiState
// PUT /api/ui-state   본문: UiState → UiState
// 64KB 이하(넘으면 413 payload_too_large). 서버는 모르는 키를 버리지 않고 그대로 돌려준다.
// revision만은 서버가 읽어 ui_state.revision 열에 따로 둔다. 없거나 정수가 아니면 400이다.
interface UiState { lastLayoutId: Uuid | null; theme: "dark" | "light"; revision: number; [k: string]: unknown }
```

#### 드로잉 (#6)

```ts
interface Drawing {
  id: Uuid;
  symbol: SymbolCode;
  tool: "trendline" | "hline" | "vline" | "rect" | "fib" | "text";
  points: DrawingPoint[];   // trendline 2, hline 1, vline 1, rect 2, fib 2, text 1
  text: string | null;      // tool이 text일 때
  style: unknown;           // 프런트엔드 소유. 64KB 이하
  updatedAt: UnixSeconds;
}
interface DrawingPoint { t: UnixSeconds; price: number }  // 봉 순서가 아니라 시각과 가격

// GET    /api/drawings?symbol=005930   → Drawing[]
// PUT    /api/drawings/:id   본문: Omit<Drawing, "updatedAt">  → Drawing
// DELETE /api/drawings/:id             → 204
```

점의 `t`는 아무 시각이나 될 수 있다. 봉 시작 시각과 맞을 필요가 없다. 봉 주기가 다른 차트에서 어느 자리에 그릴지는 브라우저가 정한다.

#### 알림 (#8)

```ts
interface Alert {
  id: Uuid;
  symbol: SymbolCode;
  condition: AlertCondition;
  repeat: "once" | "every";
  enabled: boolean;
  channels: ("telegram" | "in_app")[];
  note: string | null;
  updatedAt: UnixSeconds;
  // 아래 둘은 읽기 전용(PUT 본문에 넣지 않는다)
  warning: "realtime_limit" | null;   // 실시간 한도에 걸려 판단하지 못하는 중
  priceReference: number | null;      // 가격 알림: 서버가 쥔 직전 기준 가격. 모르면 null
}

type AlertCondition =
  | { kind: "price"; op: "gte" | "lte"; target: number }
  | { kind: "indicator"; period: Period; rule: IndicatorRule };

type IndicatorRule =
  | { kind: "crossValue"; line: LineRef; dir: "up" | "down"; value: number }
  | { kind: "crossLine"; a: LineRef; b: LineRef; dir: "up" | "down" };

interface LineRef { spec: IndicatorSpec; line: LineId }

interface AlertEvent {
  id: number;
  alertId: Uuid;
  symbol: SymbolCode;
  firedAt: UnixSeconds;
  barT: UnixSeconds;          // 판단에 쓴 봉의 시작 시각. 가격 알림은 그 체결이 속한 1분 구간의 시작
  barSource: BarSource;       // 판단에 쓴 봉의 봉 출처. 가격 알림은 언제나 "realtime"
  message: string;            // 예: "삼성전자 RSI(14) 70 상향 돌파 · 일봉 확정 71,500"
}

// GET    /api/alerts                    → Alert[]
// PUT    /api/alerts/:id   본문: Omit<Alert, "updatedAt" | "warning" | "priceReference">  → Alert
// DELETE /api/alerts/:id                → 204
// GET    /api/alert-events?limit=50     → AlertEvent[] (최신 먼저)
```

- **가격 알림**: 가격이 `target`을 **새로 넘어설 때** 울린다. 만들 때 이미 넘어 있으면 반대편으로 갔다가 다시 넘어올 때까지 울리지 않는다. 만들기 화면은 지금 현재가로 "이미 넘어 있음"을 알린다.
- **지표 알림**: 봉이 확정될 때 판단한다. 실시간으로 만든 확정 봉으로 바로 울린다. 나중에 봉 출처가 바뀌어도 정정하거나 다시 울리지 않는다. 같은 (알림, `barT`)로는 두 번 울리지 않는다. 알림 기록 화면은 `barT`와 `barSource`를 보여 준다.
- **거절되는 `LineRef`**(400 `bad_request`, 한국어 `message`)
  - 그 `spec`의 출력 선이 아닌 `line`(예: 이동평균에 `rsi`).
  - 이동된 선: `spanA`, `spanB`, `lagging`. 화면에는 이 선들을 비활성으로 보이고 이유를 적는다.

#### 지표 설정 타입 (#5. 지표 크레이트와 같은 정의)

```ts
type IndicatorSpec =
  | { kind: "ma"; method: "sma" | "ema"; period: number }                      // 종가 기준
  | { kind: "bollinger"; period: number; k: number }
  | { kind: "ichimoku"; conversion: number; base: number; spanB: number; displacement: number }
  | { kind: "volume"; maPeriod: number | null }   // 이동평균을 여럿 보려면 지표를 여러 개 띄운다
  | { kind: "rsi"; period: number; signal: number | null }
  | { kind: "macd"; fast: number; slow: number; signal: number }
  | { kind: "stochSlow"; k: number; d: number; smooth: number };

// 지표 종류별 출력 선 이름
type LineId =
  | "ma"                                                  // ma, volume
  | "upper" | "middle" | "lower"                          // bollinger
  | "conversion" | "base" | "spanA" | "spanB" | "lagging" // ichimoku
  | "volume"                                              // volume
  | "rsi" | "signal"                                      // rsi
  | "macd" | "histogram"                                  // macd (signal 포함)
  | "k" | "d";                                            // stochSlow

// WASM 공개 함수 validateSpec(specJson)의 결과(§9.4)
type SpecValidation =
  | { ok: true }
  | { ok: false; errors: { field: string; message: string }[] };  // message는 한국어 문장
```

이 TS 타입들은 서버가 Rust 타입(`crates/server/src/api.rs`)에서 생성한다(`ts-rs`). 생성 파일은 `web/src/api/generated/` 디렉터리에 타입마다 한 파일(`BarsPage.ts`, `Venue.ts` 등)로 둔다. 손대지 않는다. `crates/server/tests/contract.rs`가 생성 결과와 커밋된 파일이 같은지 검사한다. JSON 왕복 테스트(§10)가 위 필드 이름(`spanB`, `maPeriod` 등)을 고정한다.

#### 변경 알림 (#4)

같은 사용자가 탭을 여러 개 열 수 있다. 한 탭에서 사용자 자료를 바꾸면 서버가 모든 연결에 `data_changed`(§8.3)를 보낸다. 다른 탭은 그 자료를 다시 받는다. 쓰기 충돌은 나중에 쓴 쪽이 이긴다.

### 8.3 WebSocket `/api/ws` (#4)

텍스트 프레임 하나에 JSON 메시지 하나다.

#### 브라우저 → 서버

```ts
type ClientMessage =
  // (종목, 거래소, 봉 주기) 구독. sub는 브라우저가 정하는 연결 안에서 유일한 문자열.
  // 칸의 주 종목과 비교 종목 각각이 구독 하나다. venue 규칙은 GET /api/bars와 같다.
  | { type: "subscribe"; sub: string; symbol: SymbolCode; venue: Venue | null; period: Period }
  | { type: "unsubscribe"; sub: string };
```

- 같은 연결에서 같은 `(symbol, venue, period)`를 여러 `sub`로 구독해도 된다. 메시지는 `sub`마다 따로 온다. `seq`는 같은 `(symbol, venue, period)` 흐름의 번호라서 같은 값이 온다.
- `subscribe`의 `venue`는 #4에서 확정한다. 위 모양은 `SeriesKey`에 맞춘 초안이다.
- 해지하거나 연결이 끊기면 서버는 그 종목을 30초 더 받은 뒤 해지한다. 그래서 칸의 종목을 바꿨다가 바로 돌아오거나 새로고침해도 다시 받기 시작하는 지연이 없다.

#### 서버 → 브라우저

```ts
type ServerMessage =
  | { type: "hello"; protocol: 1; serverTime: UnixSeconds; status: ConnectionStatus }
  | { type: "status"; status: ConnectionStatus }

  // 구독 응답. seq는 지금 이 흐름의 번호, current는 지금의 현재 봉(없으면 null).
  // 실시간 한도로 거절되었다가 자리가 나면 같은 sub로 다시 온다.
  | { type: "subscribed"; sub: string; seq: number; current: Bar | null }
  | { type: "sub_error"; sub: string; code: "unknown_symbol" | "realtime_limit" | "kiwoom_unavailable" }

  // 현재 봉 갱신. 구독 하나당 초당 최대 10회. 중간 값은 건너뛸 수 있다.
  | { type: "bar"; sub: string; seq: number; bar: Bar }

  // 봉 확정. 연결이 살아 있는 동안 빠짐없이, 순서대로 온다. 확정 순간의 최종 값이다.
  // 이 메시지 다음의 bar 메시지는 새 현재 봉이다.
  | { type: "confirmed"; sub: string; seq: number; bar: Bar }

  // 이 구독의 확정 봉이 서버 쪽에서 바뀌었다. 브라우저는 칸을 통째로 다시 만든다(D12).
  //  gap_filled: 실시간 연결이 끊겼던 구간을 조회로 메웠다
  //  replaced:   실시간으로 만든 봉이 키움 값으로 교체되었다
  //  daily_reset: 매일 07:45에 서버가 시세 캐시를 모두 비우고 다시 받았다(수정주가 반영 등)
  // from은 바뀐 범위의 시작이다. 참고용이고 브라우저는 쓰지 않아도 된다.
  | { type: "reload"; sub: string; seq: number; reason: "gap_filled" | "replaced"; from: UnixSeconds }
  | { type: "reload"; sub: string; seq: number; reason: "daily_reset" }

  // 관심종목 현재가. 관심종목 전체에 대해 서버가 알아서 보낸다(구독 메시지 불필요).
  // 종목 하나당 초당 최대 2회. 한 메시지에 여러 종목이 묶일 수 있다.
  | { type: "quotes"; quotes: Quote[] }

  | { type: "alert_fired"; event: AlertEvent }
  | { type: "data_changed"; entity: "watchlist" | "layout" | "drawing" | "alert" | "ui_state"; id: Uuid | null };

interface ConnectionStatus {
  // 키움 실시간 연결
  //  live:         체결을 받는 중
  //  reconnecting: 끊겨서 다시 붙는 중. since부터 현재 봉이 멈춰 있을 수 있다
  //  halted:       인증 실패. 운영자가 고쳐야 한다
  realtime: "live" | "reconnecting" | "halted";
  since: UnixSeconds;
  // 끊긴 구간을 조회로 메우는 중
  backfilling: boolean;
  // 실시간 한도(200종목)를 넘어 일부 관심종목을 1분마다 조회 중
  watchlistPolling: boolean;
}
```

- **연결 직후**: 서버가 `hello`를 보낸다. 브라우저는 필요한 구독을 모두 `subscribe` 한다.
- **현재 봉 갱신 빈도**: 서버는 구독마다 최신 값 하나만 들고 있다가 100ms마다 바뀐 것만 보낸다. 그래서 구독 하나당 초당 최대 10회다.
- **확정 순간**: 봉이 확정되면 들고 있던 갱신을 버리고 `confirmed`를 바로 보낸다. `confirmed`는 연결이 살아 있는 동안 건너뛰지 않는다.
- **느린 브라우저**: 연결의 보내기 버퍼가 차면 서버는 `bar`와 `quotes`를 먼저 버린다. 그래도 `confirmed`를 넣을 자리가 없으면 연결을 닫는다. 브라우저는 다시 연결한다(아래 6번).
- **장이 닫혀 있을 때**(20:00~08:00, 주말): 연결과 구독은 그대로 된다. `bar` 메시지가 오지 않을 뿐이다.

#### 브라우저 쪽 처리 순서(D1, D2, D12)

1. `subscribe`를 보낸다.
2. 그 구독의 `bar`/`confirmed`/`reload` 메시지를 버퍼에 쌓는다.
3. `GET /api/bars` 최신 페이지를 받아 적용한다(`bars`, `current`).
4. 버퍼에서 `seq > page.seq`인 메시지만 차례로 적용하고 나머지는 버린다. `page.seq`가 `null`이면 버퍼를 모두 차례로 적용한다.
5. **`reload`를 받으면**: 그 칸의 시리즈를 통째로 비우고 2~4를 다시 한다. 구독은 유지한다. `from` 이후만 바꿔 끼우는 최적화는 하지 않는다.
6. **WebSocket이 다시 연결되면**(새 `hello`): 칸마다 시리즈를 **모두 비우고** 1~4를 다시 한다. 과거로 스크롤해 받아 둔 구간은 버린다. 드로잉은 따로 저장되므로 영향이 없다.
7. **오래된 응답 버리기**: 칸마다 시리즈 세대 번호를 둔다. `reload`가 오거나 종목·봉 주기가 바뀌면 세대를 올린다. 이전 세대의 REST 응답과 WASM 결과는 버린다.

### 8.4 서버 쪽 구현 메모(브라우저가 몰라도 되는 것)

```rust
/// 연결 하나의 쓰기 태스크.
struct ConnWriter {
    /// confirmed, reload, subscribed 등 버리면 안 되는 메시지. 용량 256.
    must: mpsc::Receiver<ServerMessage>,
    /// 구독별 최신 현재 봉. 덮어쓰기만 한다.
    latest: HashMap<SubId, (u64 /* seq */, Bar)>,
    dirty: BTreeSet<SubId>,
    // 100ms 타이머마다 dirty를 비우며 bar 메시지를 보낸다.
}
```

`bar`를 건너뛰어도 `seq`는 흐름 전체의 번호다. 그래서 브라우저가 받는 `seq`는 띄엄띄엄일 수 있다. 브라우저는 `seq`의 크기만 비교한다.

### 8.5 정적 파일 (#2)

서버 하나가 SPA 정적 파일도 내보낸다(ADR 0002). 경로마다 규칙이 다르다.

| 경로 | 응답 |
|---|---|
| `/api/*` 중 없는 경로 | 404 JSON `ApiError { code: "not_found" }`. `index.html`로 보내지 않는다 |
| `/api/ws` | WebSocket 업그레이드 |
| `/assets/*`(Vite가 해시를 붙인 파일) | 있으면 파일. `Cache-Control: public, max-age=31536000, immutable`. 없으면 404(본문 없음) |
| `*.wasm` | `Content-Type: application/wasm`(`instantiateStreaming`에 필요). `/assets` 아래면 위와 같은 캐시 규칙 |
| `/index.html` | `Cache-Control: no-cache`(매번 재검증) |
| 그 밖의 경로 중 마지막 조각에 확장자가 있는 것(예: `/favicon.ico`) | 있으면 파일, 없으면 404 |
| 그 밖의 경로(예: `/layout/0193…`, `/alerts`) | **SPA 경로 되돌리기**: `index.html`을 200으로. `Cache-Control: no-cache` |

- js, css, wasm, json은 gzip·br로 압축해 보낸다(`tower-http` `CompressionLayer`).
- 정적 파일 위치는 `VALLY_STATIC_DIR`(§11.1)이다.

---

## 9. 지표 크레이트 API

> 켜지는 단계: #5(서버의 지표 알림은 #8)

브라우저(WASM)와 서버(지표 알림)가 같은 크레이트를 쓴다(ADR 0002).

### 9.1 입력과 출력

```rust
/// 열 단위 입력. WASM 경계에서 Float64Array 여섯 개로 그대로 받을 수 있다.
pub struct Columns<'a> {
    pub t: &'a [i64],      // 봉 시작 시각, Unix 초. 오름차순
    pub open: &'a [f64],
    pub high: &'a [f64],
    pub low: &'a [f64],
    pub close: &'a [f64],
    pub volume: &'a [f64],
}

/// 브라우저 계약의 IndicatorSpec과 같은 모양(serde, ts-rs).
/// rename_all은 변형 이름에, rename_all_fields는 변형 안 필드 이름에 적용된다. 둘 다 필요하다.
#[derive(Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Spec {
    Ma { method: MaMethod, period: u16 },
    Bollinger { period: u16, k: f64 },
    Ichimoku { conversion: u16, base: u16, span_b: u16, displacement: u16 },  // JSON: spanB
    Volume { ma_period: Option<u16> },                                         // JSON: maPeriod
    Rsi { period: u16, signal: Option<u16> },
    Macd { fast: u16, slow: u16, signal: u16 },
    StochSlow { k: u16, d: u16, smooth: u16 },                                 // JSON kind: "stochSlow"
}

impl Spec {
    /// 설정값 검사(기간 1 이상, fast < slow 등). 오류는 필드 이름과 한국어 문장.
    pub fn validate(&self) -> Result<(), Vec<SpecError>>;
    /// 첫 유효 값이 나오기까지 필요한 봉 수.
    pub fn warmup(&self) -> usize;
    pub fn lines(&self) -> Vec<LineId>;
    pub fn shift_of(&self, line: LineId) -> Option<i32>; // 그 spec의 선이 아니면 None
}

pub struct SpecError { pub field: String, pub message: String }

/// 선 하나의 값. values[i]는 입력 봉 i + shift 번째 위치의 값이다. 값이 없으면 NaN.
pub struct Line {
    pub id: LineId,
    pub shift: i32,        // 일목 선행스팬 +(displacement−1), 후행스팬 −(displacement−1), 나머지 0
    pub values: Vec<f64>,  // 길이 = 입력 봉 수
}

pub struct Output { pub lines: Vec<Line> }

/// 한 번에 전부 계산한다. 서버의 지표 알림은 이것만 쓴다(§7.3).
pub fn compute(spec: &Spec, bars: &Columns) -> Output;
```

- 출력 위치는 **봉 순서(index)** 다. 시각이 아니다. 시각으로 바꾸는 것은 호출자가 `t[i + shift]`로 한다.
- `i + shift`가 입력 범위를 넘으면(선행스팬의 마지막 displacement−1개) 미래 봉 시작 시각이 필요하다. 이것은 `future_bar_starts`가 만든다(§9.3).

### 9.2 현재 봉 하나만 바뀌었을 때

현재 봉은 체결마다 바뀌고 확정 봉은 바뀌지 않는다. 그래서 상태를 "확정 봉까지"로 들고 있다가, 현재 봉은 그 상태의 복사본에 한 봉을 더해 미리 본다. 브라우저가 쓴다.

```rust
pub struct Engine {
    spec: Spec,
    state: State,      // 확정 봉까지 계산한 상태. 지표 종류마다 다르다(EMA 직전 값, 창 버퍼 등)
    output: Output,    // 확정 봉까지의 출력
}

pub struct BarInput { pub t: i64, pub open: f64, pub high: f64, pub low: f64, pub close: f64, pub volume: f64 }

/// 마지막 위치(현재 봉 또는 방금 확정한 봉)의 값. 선마다 하나.
/// 이동된 선은 그 선이 그려지는 위치(i + shift)의 값이다.
pub struct Tail { pub values: Vec<(LineId, f64)> }

impl Engine {
    /// 확정 봉 전체로 만든다. compute와 같은 결과를 output에 담는다.
    pub fn new(spec: Spec, confirmed: &Columns) -> Self;
    /// 확정 봉 하나를 더한다. O(창 크기) 이하. 확정 순간의 최종 값을 돌려준다.
    pub fn push_confirmed(&mut self, bar: &BarInput) -> Tail;
    /// 현재 봉을 넣었을 때의 마지막 값. 상태를 바꾸지 않는다.
    pub fn preview(&self, current: &BarInput) -> Tail;
    pub fn output(&self) -> &Output;
}
```

- 과거로 스크롤해서 앞쪽 봉이 늘면 `Engine::new`로 다시 만든다. 앞쪽이 바뀌면 EMA 계열 값이 모두 바뀌므로 덧붙일 수 없다.
- **불변식(테스트로 고정)**
  - 어떤 봉 목록이든 `Engine::new(앞 n−1개)` 뒤 `push_confirmed(n번째)`의 출력은 `compute(n개)`와 같다.
  - `preview(x)`의 값은 `compute(확정 봉 + x)`의 마지막 위치 값과 같다.
- `push_confirmed`가 `Tail`을 돌려주므로, 브라우저는 확정 순간의 최종 값으로 선과 범례를 바로 갱신할 수 있다.

### 9.3 미래 봉 시각(일목 선행스팬, 드로잉 외삽)

```rust
// domain::Period
/// last 다음부터 n개의 봉 시작 시각. 공휴일은 모르므로 건너뛰지 않는다(알려진 한계).
/// 이 함수는 indicators의 wasm feature로 브라우저에도 나간다.
pub fn future_bar_starts(self, last: Bucket, n: usize) -> Vec<KstTime>;
```

봉 주기마다 다음 봉 시작 시각을 만드는 규칙이 다르다. "주말 건너뛰기"는 분봉과 일봉에만 해당한다.

| 봉 주기 | 다음 봉 시작 |
|---|---|
| 분봉 | n분 뒤. [08:00, 20:00) 밖이면 다음 평일 08:00으로 건너뛴다. 토·일은 건너뛴다 |
| 일 | 다음 날 00:00. 토·일은 건너뛴다 |
| 주 | 다음 월요일 00:00. 건너뛰는 날이 없다 |
| 월 | 다음 달 1일 00:00. 1일이 주말이어도 1일이다 |

- 브라우저는 이 시각들로 Lightweight Charts의 빈 시각(whitespace) 데이터를 만들어 선행스팬을 그린다. 드로잉의 외삽도 이 함수로 한다. 그리는 방법은 프런트엔드 설계의 몫이다.
- 공휴일 때문에 미래 시각이 하루 어긋날 수 있다. 그 봉이 실제로 생기면 그때 실제 시각으로 다시 그려진다.
- 분봉에서는 체결 없는 분도 시각으로 센다. 그래서 거래가 뜸한 종목은 미래 위치가 실제와 다를 수 있다.

### 9.4 WASM 바인딩

`indicators`에 `wasm` feature를 둔다. 켜면 `wasm-bindgen`으로 다음을 내보낸다. 서버 빌드에는 `wasm-bindgen`이 들어가지 않는다.

```rust
/// 계산 엔진을 만들지 않고 spec만 검사한다. 입력할 때마다 불러도 된다.
/// 결과는 SpecValidation(§8.2) JSON 객체. JSON 파싱 실패도 { ok: false, errors: [{ field: "", message }] }.
#[wasm_bindgen(js_name = validateSpec)]
pub fn validate_spec(spec_json: &str) -> JsValue;

#[wasm_bindgen]
pub struct WasmEngine(Engine);

#[wasm_bindgen]
impl WasmEngine {
    #[wasm_bindgen(constructor)]
    pub fn new(spec_json: &str, t: &[f64], o: &[f64], h: &[f64], l: &[f64], c: &[f64], v: &[f64])
        -> Result<WasmEngine, JsError>;
    /// [line0, line1, …] 순서의 Float64Array. 선 순서는 lines()와 같다. 확정 순간의 최종 값.
    #[wasm_bindgen(js_name = pushConfirmed)]
    pub fn push_confirmed(&mut self, t: f64, o: f64, h: f64, l: f64, c: f64, v: f64) -> Vec<f64>;
    /// 위와 같은 순서. 상태를 바꾸지 않는다.
    pub fn preview(&self, t: f64, o: f64, h: f64, l: f64, c: f64, v: f64) -> Vec<f64>;
    /// 선 하나 전체. shift는 shift(index)로 따로 받는다.
    pub fn line(&self, index: usize) -> Vec<f64>;
    pub fn shift(&self, index: usize) -> i32;
    pub fn lines(&self) -> Vec<String>;
}

#[wasm_bindgen(js_name = futureBarStarts)]
pub fn future_bar_starts(period: &str, last_start: f64, n: usize) -> Result<Vec<f64>, JsError>;
```

계산은 React 렌더링 밖에서 한다(#5). Web Worker를 권한다. 이것은 프런트엔드 설계의 몫이다.

### 9.5 지표 종류 일곱 가지

| 지표 종류 | `Spec` | 기본 설정값 | 출력 선 | 계산 메모 |
|---|---|---|---|---|
| 이동평균 | `Ma { method, period }` | sma 20 | `ma` | 종가. EMA는 첫 `period`개의 단순평균에서 시작한다. α = 2/(n+1) |
| 볼린저 밴드 | `Bollinger { period, k }` | 20, 2.0 | `upper` `middle` `lower` | 표준편차는 모표준편차(n으로 나눔) |
| 일목균형표 | `Ichimoku { … }` | 9, 26, 52, 26 | `conversion` `base` `spanA` `spanB` `lagging` | 선행스팬은 shift +(displacement−1), 후행스팬 −(displacement−1). 기본 26이면 25봉 앞(오늘을 1로 세어 26번째) |
| 거래량 | `Volume { ma_period }` | 20 | `volume`, `ma` | 이동평균 여러 개는 지표를 여러 개 띄워서 본다 |
| RSI | `Rsi { period, signal }` | 14, null | `rsi`, `signal` | Wilder 평활. signal은 RSI의 단순평균 |
| MACD | `Macd { fast, slow, signal }` | 12, 26, 9 | `macd` `signal` `histogram` | EMA |
| 스토캐스틱 슬로우 | `StochSlow { k, d, smooth }` | 5, 3, 3 | `k` `d` | 국내 HTS 관행 |

- **참조값**: 공개된 계산 예시표(Wilder의 RSI 원문 예시, StockCharts 예시 등)를 고정 파일로 커밋한다. 출처를 파일 머리에 적는다. 키움 HTS 화면 값으로 몇 점을 더 확인한다. 특히 일목 선행스팬 이동량과 스토캐스틱 값은 HTS와 맞춰 본다.
- EMA 계열(EMA, MACD, RSI)은 입력이 시작하는 봉에 따라 값이 조금 다르다. 서버 알림은 최근 N개로 매번 다시 계산하고(§7.3) 화면은 불러온 봉 전체로 계산한다. 그래서 두 값이 아주 조금 다를 수 있다.

---

## 10. 테스트

> 켜지는 단계: 각 대상의 단계와 같다

| 대상 | 방법 | 위치 | 단계 |
|---|---|---|---|
| 봉 경계·확정 시각 | 표 기반 테스트. 봉 주기마다 08:00:00, 08:59:59, 09:00:00, 15:30:00, 19:59:59, 20:00:03(19:59 봉), 20:00:10(창 밖), 금요일 20:00:10, 장 중간 분봉의 끝 + 2초, 월말 마지막 평일, 월초. 다음 구간 체결로 닫기와 타이머로 닫기 중 먼저 오는 쪽 | `domain` | #2·#4 |
| 미래 봉 시각 | `future_bar_starts` 표 기반 테스트. 분봉: 19:59 다음은 다음 평일 08:00, 금요일 19:59 다음은 월요일 08:00. 일봉: 금요일 다음은 월요일. 주봉: 연말을 넘는 주(예: 2026-12-28 → 2027-01-04), 월요일이 1일인 주. 월봉: 12월 → 다음 해 1월, 1일이 토·일인 달(예: 2026-11-01(일), 2027-05-01(토))도 1일 | `domain` | #5 |
| 체결 날짜 정하기 | 수신 시각과 체결시간 쌍을 손으로 쓴다. 창 밖, 미래, 너무 과거 | `domain` | #4 |
| 현재 봉 집계 | 손으로 쓴 체결 목록 → `aggregate` → 손으로 쓴 확정 봉 목록·현재 봉과 비교. 시드 경계(`DayCum`, `Unknown`), 늦은 체결, 체결 없는 분, 단일가 체결 한 건, 불완전한 봉의 `needs_verify` | `domain` | #4 |
| 알림 판단 | 손으로 쓴 체결 목록으로 가격 알림: 아래에서 위로 넘어섬, 만들 때 이미 넘어 있음(안 울림), 반대편 갔다 다시 넘어섬(every), 기준 가격 없음 → 첫 체결은 기준만. 손으로 쓴 지표 값 쌍으로 교차: 같은 값, NaN | `domain` | #8 |
| 지표 알림 기록 | `sqlx::test`(sqlite)로 같은 (알림, `bar_t`) 두 번 → 한 번만 보냄. `bar_source` 직렬화 이름이 `realtime`/`kiwoom` | `server::alert` | #8 |
| 구독 관리자 | `hold`/`release`/`plan`을 시각과 함께 부르는 시나리오: 30초 유예, 유예 중 `hold`로 취소, 200 한도, 새 종목이 기존 칸·알림을 밀어내지 않음, 유예 종목 → 관심종목만 잡은 종목 순으로 밀려남, 넘친 관심종목 → `polled`, `release_conn`, 자리가 나면 `rejected` 회복 | `server::market`(순수 부분) | #4 |
| 복구 순서 | 가짜 `BarService`로: 복구 중 체결 쌓기, 세대가 다른 응답 버리기, 복구 중 재단절, 실패 뒤 재시도 | `server::market` | #4 |
| 지표 | 지표 종류마다 참조값 고정 파일(CSV)과 대조(허용 오차 1e-6). §9.2 불변식을 proptest로: 무작위 봉 목록에서 증분 결과 = 전체 계산 결과 | `indicators` | #5 |
| 지표 설정 JSON | `Spec`의 JSON 왕복. 적어도 `{"kind":"ichimoku","conversion":9,"base":26,"spanB":52,"displacement":26}`와 `{"kind":"volume","maPeriod":20}`, `stochSlow`가 그대로 오가는지. ts-rs 생성 파일에 같은 이름이 나오는지 | `indicators` | #5 |
| 키움 파서 | `docs/kiwoom.md`의 응답 예시를 `server/tests/fixtures/kiwoom/*.json`로 그대로 옮긴다. 파일 머리에 출처(문서 절)를 적는다. 아래 목록 참고 | `server::kiwoom::wire` | #2 |
| 허용 목록 | 소스 전체에서 주문·계좌 경로와 api-id 문자열을 찾는 구조 검사(§4.4) | `server` | #2 |
| 거래소 | `Venue` 직렬화 왕복과 `"KRX"` 거절, `Feed::new`(지수 + 거래소 → None, 주식 + 없음 → 통합), `kiwoom_stock_code`(`_AL`·없음·`_NX`), 요청 본문의 `stk_cd` | `domain`, `server::kiwoom::api` | #14 |
| 봉 질의 | `venue` 생략(주식 → combined, 지수 → null), 지수 + `venue` → 400, 모르는 값 → 400, NXT 불가 종목 + `nxt` → 400이고 키움 요청 0건, `BarsPage.venue` | `server::http` | #14 |
| 분봉 과거 조회 | 가짜 응답으로: 900봉 페이지, `cntr_tm` → 구간 시작, 15분 넘은 키는 가장 이른 봉의 날짜로 건너뜀(오늘부터 따라가지 않음), 겹친 날 덮어쓰기, `cont-yn: N`에서 `nextBefore = null` | `server::bars` | #14 |
| 대기열 | 가짜 시계와 가짜 전송으로: 어느 1초 구간에도 4회 이하(토큰 발급·다시 보내기·연속조회 포함), 토큰 발급 먼저, `Screen` 먼저, 같은 요청 한 번, 합치기 범위가 다르면 따로 보냄, 요청 개수 초과 뒤 1초 멈춤, `[8005]` 뒤 한 번 발급하고 한 번 다시 보냄, au10001 실패 시 기다리던 요청 모두 실패. `Recovery` 몫(4번 중 1번)은 #4 | `server::kiwoom::rest` | #2 |
| 메모리 캐시 | DB 없이 가짜 `MarketRequest` 응답과 가짜 시계로: 같은 종목의 거래소별 시리즈가 따로임, 과거로 늘리기, 앞으로 늘리기, 실시간으로 만든 봉 붙이기 조건(세션 끊김, 시리즈 없음), 출처 교체(키움은 덮어쓰고 실시간은 못 덮어씀), **시리즈를 내린 뒤·07:45 비운 뒤 도착한 응답은 버림(`SeriesId`가 다름)**, 응답이 시리즈를 새로 만들지 않음, 10분 내리기(구독·알림·최근 REST 요청 중 하나라도 있으면 유지), 07:45 비우기 뒤 구독 중인 키 다시 채우기와 `reload { reason: "daily_reset" }`, 같은 요청 합치기 | `server::bars` | #2·#4 |
| 종목 목록·검색 | 켤 때 목록 받기 전 요청은 기다림, 07:45 갱신 실패 시 이전 목록 유지. ka10099 고정 입력으로 `marketCode` 거르기, 우선주 코드 규칙(`03481K` 포함). 검색 순위·동점 순서·이름 순서(`삼성전자` < `삼성SDI`)·초성·정규화 표 기반 테스트 | `server::symbols` | #2 |
| 정적 파일 | `/api/없는경로` → JSON 404, `/assets/없는.js` → 404, `/layout/x` → index.html, `.wasm` MIME, 캐시 헤더 | `server::http` | #2 |
| 브라우저 계약 | ts-rs 생성 파일이 커밋된 것과 같은지 CI 검사. 서버 → 브라우저 메시지 JSON 스냅숏 테스트 | `server::http` | #2·#4 |
| 잠금 파일 | 임시 디렉터리의 잠금 파일로: 첫 `InstanceLock::acquire` 성공, 같은 경로 두 번째는 `Held { pid }`, 첫 잠금을 drop하면 다시 잡힘, 남아 있는 파일(잠금 없음)은 막지 않음. 통합 테스트: 서버 두 번째 실행이 종료 코드 1로 끝나고 키움 요청을 보내지 않음 | `server::instance` | #2 |
| 사용자 자료 | `sqlx::test`(sqlite, 테스트마다 새 DB)로: 마이그레이션, 레이아웃 PUT 두 번(같은 결과), 레이아웃 지우면 칸도 지워짐(`foreign_keys`), 마지막 레이아웃 삭제 거절, `ui_state`의 모르는 키 왕복과 64KB 초과 거절, 잘못된 JSON은 `json_valid`로 거절. 연결 설정(`journal_mode=wal`, `foreign_keys=1`, `busy_timeout=5000`)을 `PRAGMA`로 읽어 확인 | `server::db`, `server::userdata` | #3 |
| 비밀값 | `Config`, `KiwoomAuth`, 텔레그램 클라이언트의 `Debug` 출력에 비밀값이 없는지 | `server::config` | #2 |

**키움 파서 고정 입력**(kiwoom.md에서 옮긴다)

- ka10081 일봉 행: 부호 없는 가격(§1).
- ka10080 1분봉 행: 시·고·저·종 모두 `-` 부호(§1).
- ka20005 지수 분봉: `--32411` 이중 부호, 100배 정수(§6).
- ka20006 지수 일봉: `505969` → 5,059.69(§6).
- ka20006 코스피 1996-11-04: 저가가 종가보다 높은 실제 행(§4.6 보정).
- ka10082·ka10083, ka20007·ka20008: 주봉·월봉 `dt` 맞추기(10.4·10.5절).
- ka10099 행과 ka10100 응답(§5). `nxtEnable` `Y`·`N`이 둘 다 있는 행.
- ka10080 `_AL`·KRX·`_NX` 1분봉과 60분봉 행, ka20005 지수 분봉(1·13절). #14에서 옮긴다.
- NXT 불가 종목의 `_NX` 빈 행: `005935_NX` 일봉과 1분봉(12.4·13절). #14에서 옮긴다.
- 없는 코드의 빈 행: ka10081 `stk_cd=999999`, ka20006 `inds_cd=999`(§9).
- 필수 입력 누락: `return_code: 2`, `return_msg`의 `[1511:…]`(§9).
- WebSocket: LOGIN 응답, REG 응답, PING, REMOVE `105112`(§8).
- 0J REAL 프레임: kiwoom.md 11.5의 hoga-ops 장중 원본(소수 문자열, 방향 부호). 0B REAL 프레임은 우리가 직접 받은 원본이 아직 없다. 공개 명세 예시로 임시 고정 입력을 만들고 장중 실측 뒤 교체한다.

녹화 기능이나 재생 원천은 두지 않는다(ADR 0003). 실시간 경로 전체는 평일 08:00~20:00에 실제 키움으로만 돌려 본다. 그래서 그 경로의 판단 로직을 모두 순수 함수(`domain`)와 `SubscriptionManager::plan`으로 몰았다.

---

## 11. 설정

> 켜지는 단계: #2(텔레그램은 #8, 사설망 주소는 #9)

### 11.1 `.env` 키

설정은 프로세스 환경변수와 `VALLY_ENV_FILE`이 가리키는 파일에서 읽는다. 값은 이 문서에 적지 않는다.

- `VALLY_ENV_FILE`은 `.env` 형식 파일의 **절대 경로**다. 상대 경로면 시작하지 않는다. `./.env`를 찾아보는 대체 경로는 없다. 어느 디렉터리에서 켜든 같은 파일을 읽게 하려는 것이다.
- `VALLY_ENV_FILE`이 없으면 프로세스 환경변수만 쓴다.
- 같은 키가 둘 다에 있으면 프로세스 환경변수가 이긴다.
- 파일은 `KEY=VALUE` 줄만 읽는다. 빈 줄과 `#` 줄은 건너뛰고, 앞의 `export `와 값을 감싼 따옴표 한 쌍을 벗긴다.

| 키 | 필수 | 뜻 |
|---|---|---|
| `VALLY_ENV_FILE` | 아니오 | 위 설정 파일의 절대 경로 |
| `VALLY_KIWOOM_APP_KEY` | 예 | 실계좌 앱키(ADR 0004) |
| `VALLY_KIWOOM_APP_SECRET` | 예 | 실계좌 시크릿(ADR 0004) |
| `VALLY_KIWOOM_BASE_URL` | 아니오 | 키움 REST 주소. 기본 `https://api.kiwoom.com`. 통합 테스트가 가짜 키움 서버를 가리키는 데 쓴다 |
| `VALLY_DB_PATH` | 아니오 | 사용자 자료 SQLite 파일 경로. 기본 `data/vally.db`. #2에서는 읽지 않는다 |
| `VALLY_LOCK_PATH` | 아니오 | 잠금 파일 경로(§4.1). 기본 `$XDG_RUNTIME_DIR/vallythevally/server.lock`, 없으면 `/tmp/vallythevally-<uid>/server.lock` |
| `VALLY_BIND` | 아니오 | 받는 주소. 기본 `127.0.0.1:8080` |
| `VALLY_TELEGRAM_BOT_TOKEN` | 아니오 | 없으면 텔레그램 채널을 끈다(#8 전에는 없어도 된다) |
| `VALLY_TELEGRAM_CHAT_ID` | 아니오 | 위와 함께 |
| `VALLY_STATIC_DIR` | 아니오 | SPA 빌드 결과 위치. 기본 `web/dist` |
| `VALLY_LOG` | 아니오 | `tracing` 필터. 기본 `info` |

이 밖의 `VALLY_` 키가 있으면 시작할 때 경고한다(오타를 찾으려는 것이다). 모의 키 설정은 없다.

### 11.2 받는 주소

```rust
pub struct BindAddr(SocketAddr); // 루프백만. 생성자에서 검사

impl BindAddr {
    pub fn parse(s: &str) -> Result<Self, ConfigError>; // 127.0.0.0/8 또는 ::1 이 아니면 시작 실패
}
```

- 서버는 `127.0.0.1`에서만 받는다(ADR 0001). `0.0.0.0`이나 공인 주소를 주면 시작하지 않는다.
- #9에서 사설망 인터페이스 주소(예: Tailscale 100.64.0.0/10)를 허용 범위에 더한다. 그때도 공인 주소와 `0.0.0.0`은 받지 않는다.

### 11.3 로그에서 비밀값 가리기

```rust
/// Debug와 Display 모두 "[가림]"만 낸다. 값은 expose()로만 꺼낸다.
pub struct Secret<T>(T);
impl<T> Secret<T> { pub fn expose(&self) -> &T; }
```

- 앱키, 시크릿, 접근토큰, 텔레그램 봇 토큰, DB 비밀번호가 들어간 URL은 모두 `Secret`이다.
- 키움 요청을 로그에 남길 때는 api-id, 우선순위, 소요 시간, `return_code`, 상세 코드만 남긴다. 헤더와 au10001 요청·응답 본문은 남기지 않는다.
- 텔레그램 봇 토큰은 URL 경로에 들어간다(`/bot<token>/sendMessage`). `reqwest` 오류는 URL을 품고 있으므로, 로그에 남기기 전에 `without_url()`로 지운다.
- WebSocket LOGIN 메시지는 로그에 남기지 않는다.
- 파싱 실패 로그에 응답 원문을 남기는 것은 차트·종목 조회 응답만이다.

---

## 12. 실측 대기 항목

`docs/kiwoom.md`의 결과를 반영했다. 1~10절은 2026-11-08 일요일 밤의 조회 실측, 11절은 hoga-ops 근거(D16), 12·13절은 2026-11-09 새벽의 조회 실측이다.

### 12.1 확인된 것(설계에 반영함)

| 항목 | 결과 | 반영한 곳 |
|---|---|---|
| 한 번에 오는 봉 수 | 일 600, 분 900, 주 300, 월 240. 마지막 페이지만 짧다 | §6.5 |
| 분봉을 과거 어디까지 | 1분·60분 모두 마지막 관측일로부터 1년 | §6.5 하한(U1) |
| 분봉 `base_dt` | 있다. 빼도 오늘과 같다. 과거 날짜로 바로 갈 수 있지만 그 날짜 뒤의 권리발생이 빠진다(kiwoom.md 4.1절). 주식은 쓰지 않고 지수만 쓴다 | §4.5, §6.3 |
| 일봉 `base_dt` | 필수. 빠지면 1511 | §4.5 |
| 수정주가 | `upd=1`에 `base_dt=오늘`로 연속조회하면 과거 전체가 수정주가 | §6.3 |
| 재시작 비용 | 처음 열 때 일봉·분봉 1회, 주봉 2회, 월봉 3회 조회. 캐시 없이도 몇 초 안에 뜬다 | §0, §6.1 |
| `_AL` 차트 조회 | 일봉·분봉에서 통한다. 일봉은 NXT 이전 구간을 KRX 값으로 끊김 없이 채운다 | §2.1 |
| 분봉 시각 | 구간 시작. 60분봉은 정시 | §3.2 |
| 주·월봉 `dt` | 구간의 첫 관측일(예: 11월 월봉 `20261102`). 주봉은 월요일, 월봉은 1일로 맞춘다 | §3.2 |
| 체결 없는 분 | 키움도 건너뛴다 | §3.2 |
| 마지막 체결 | 19:59:59. 체결 창 [08:00, 20:00) | §3.1 |
| 일봉 종가 | 그날 마지막 봉(19:59)의 종가. 일봉은 20:00 뒤에 확정 | §3.3 |
| 일봉 거래량 ≠ 분봉 합 | 매일 다르다. 실시간으로 만든 봉을 키움 값으로 교체해야 한다 | §6.4 |
| 없는 종목코드 | 성공 응답(`return_code: 0`)에 모든 필드 `""`인 행 하나 → `unknown_symbol` | §4.3 |
| 오류 코드 위치 | 최상위 `return_code`가 아니라 `return_msg` 안 `[NNNN:` | §4.3 |
| 가격 부호 | 믿지 않는다. 절댓값과 `pred_pre_sig`. 현재가의 등락은 방향 필드와 기준가로 계산 | §4.6 |
| 지수 가격 | REST는 100배 정수(`505969` = 5,059.69) | §4.6 |
| 거래대금 단위 | TR마다 다르다(일봉 백만원, 주·월봉 원). 쓰지 않는다 | §2.2, §4.6 |
| ka10099 | `mrkt_tp=0`에 ETF·ETN·리츠 등이 섞인다. `marketCode`로 거른다. 우선주는 코드 끝자리 | §6.6 |
| 지수 코드 | 코스피 `001`, 코스닥 `101`. 지수 분봉은 09:00~15:30 | §2.1 |
| WebSocket 주소, LOGIN, PING | 문서대로. PING은 10초마다 텍스트 메시지 | §5.1 |
| REG | 한 원소에 여러 종목. type 섞어도 된다 | §5.1 |
| REMOVE | type별로 따로. 섞으면 105112 | §5.1 |
| 요청 개수 초과 | HTTP 429, `return_code: 5`, `[1700:… 유량=5 …]`. 100ms 안에 7회까지 통과, 8번째에 걸림(창 방식은 모름). 운영은 초당 4회 | §4.2, §4.3 |
| 토큰 무효 | HTTP 200, `return_code: 3`, `[8005:Token이 유효하지 않습니다]`. HTTP 401이 아니다 | §4.3 |
| `next-key` 유효 시간 | 15분 묵혀도 통함. 이어 받은 봉에 빠짐·겹침 없음 | §6.3 |
| 주봉·월봉 `_AL` | 통한다. NXT 이전은 KRX와 같다. 진행 중인 주·달도 봉으로 준다 | §2.1, §5.4 |
| 지수 주봉·월봉 | ka20007·ka20008. 배열 `inds_stk_pole_qry`·`inds_mth_pole_qry`. 값은 100배 정수, 부호 없음. 한 페이지 300·240 | §4.4, §4.6 |
| ka10095 | 한 번에 100종목까지. 101종목부터 `return_code: 5`, `[1634]`. 기준가 `base_pric`, 방향 `pred_pre_sig`. 연속조회 없음 | §4.3, §4.6, §5.3 |
| WebSocket REG 한도 | 그룹당 200(`105118`), 접속 전체 200(`105115`). 0J도 여기에 센다. 원소 하나의 한도는 없다 | §5.1, §5.3 |
| 토큰 유효 기간 | 발급 후 24시간 | §4.1 |
| 같은 토큰으로 다시 접속 | 매번 LOGIN 성공 | §5.1 |
| `_AL` 0B(11.1, D16) | KRX와 NXT 체결을 한 흐름으로 준다. `9081`이 거래소를 가른다 | §5.3 |
| 0B `9081`(11.2) | 문자열 `KRX`/`NXT`(정규장에서 확인) | §5.3 |
| 0B 필드(11.3) | 명세대로. 15의 부호가 체결 방향, 20이 실제 체결 시각 | §4.6 |
| 0J 가격(11.5, D16) | 100배 정수가 아니라 방향 부호가 붙은 소수 2자리 문자열 | §4.6 |
| 단일가 체결(11.6) | 15:30 종가 단일가는 15:30:00대 대량 체결 한 건으로 1530 봉에 든다. 09:00 시가 단일가는 첫 체결 시각의 분 봉에 든다(09:02인 날도 있다) | §3.2, §5.4 |
| 20:00 이후 체결(11.8, D16) | 20:00:00~20:00:03 체결이 온다. 키움은 19:59 봉에 넣는다 | §3.1, §3.3 |
| 새 토큰과 WebSocket(11.10, D16) | 새 토큰은 기존 세션을 끊지 않는다. 옛 토큰의 REST가 `[8005]`로 실패한다. 세션을 끊는 것은 같은 앱키의 두 번째 LOGIN(close 1000)이다 | §4.1, §5.1 |
| 08:00 첫 체결(11.9) | 08:00 정각에 접속하면 첫 체결을 놓칠 수 있다 | §5.2 |
| 거래소별 일봉(12.1) | `_AL`·KRX·`_NX`가 거래소마다 다른 봉을 준다. 2026-09-14부터 KRX 일봉 종가도 애프터마켓의 마지막 체결가다 | §2.1, §8.2 |
| NXT 불가 종목의 `_NX`(12.4, 13절) | 없는 종목과 같은 빈 행 하나. `_AL`은 KRX와 같다 | §4.3, §8.2 |
| `_NX` 분봉(13절) | 온다. 한 페이지 900봉, `cntr_tm`은 구간 시작 KST, 하루 08:00~19:59. 1년 끝도 `_AL`과 같다(2025-11-03) | §4.5, §6.5 |
| 분봉 시작 경계(13절) | 3·30분봉의 시작이 모두 자정 기준 N분 경계 | §3.2 |

### 12.2 장중 실측 대기(장중에만 잴 수 있다)

D16(kiwoom.md 11절)으로 풀린 항목은 12.1로 옮겼다. 남은 것은 아래와 같다.

| # | 항목 | 기본값(이 설계가 가정한 것) | 틀리면 바꿀 곳 |
|---|---|---|---|
| 1 | 0B 누적거래량(13)의 하루 합계가 일봉 `trde_qty` 기준인가 분봉 합 기준인가. 분 안의 증분은 REST 분봉과 같다(11.4) | 모른다 → 시드 경계를 믿지 않음(`Unknown`) | §5.4. 같으면 `DayCum`으로 바꾼다 |
| 2 | 0J 13·15의 단위(11.5) | 받은 값 그대로 | §4.6 |
| 3 | 09:00 시가 단일가가 0B 한 건으로 오는가(11.6) | 한 건, 그 체결시간의 구간 | 집계 테스트 |
| 4 | KRX 코드의 15:30~16:00 체결, 15:35 봉의 정체(`_NX`에도 있다), 애프터마켓 시간대의 `290`·`9081` 값(11.7, 13절) | REST 봉은 키움이 준 대로 그린다. 실시간은 `_AL` 한 흐름을 `9081`로 나눈다 | §5.3. `9081`이 애프터마켓에서 거래소를 가르지 못하면 거래소 코드를 따로 REG 한다 |
| 5 | 20:00:03보다 늦은 체결이 오는가(11.8) | 20:00:10까지만 받는다 | §3.1 창, `CLOSE_GRACE_SECS` |
| 6 | 07:50 강제 단절의 Close 코드와 다시 접속되는 시각, 일요일 05:00(11.9) | 바로 붙는다. 안 되면 30초마다 재시도 | §5.2 |
| 7 | ka10099 `lastPrice`가 장중에 오늘 기준가인가(11.11) | 쓰지 않는다 | §4.6 |

### 12.3 조회로 잴 수 있지만 아직 안 잰 것

| # | 항목 | 기본값 | 바꿀 곳 |
|---|---|---|---|
| 1 | 만료된 진짜 토큰의 응답이 가짜 토큰과 같은 형태(HTTP 200, `return_code: 3`, `[8005]`)인가. 2026-11-09 22:48 만료 뒤에 확인할 수 있다 | 같다 | §4.3 |
| 2 | `next-key`가 15분을 넘겨도 통하는가, 장중에 새 봉이 붙는 동안에도 같은 자리를 가리키는가 | 15분 안에만 쓴다. 넘으면 오늘부터 다시 따라간다. 지수 분봉만 날짜로 건너뛴다 | §6.3 |
| 3 | **키움이 수정주가를 언제 반영하는가**: 권리락·액면분할 당일 07:45 이전에 `upd_stkpc_tp=1` 조회가 이미 수정된 값을 주는가. 즉 07:45 비우기가 충분한가. 수정 사유가 생기는 날(권리락일 전후)에 07:45·08:00·장중 세 번 일봉을 받아 비교한다 | 충분하다(07:45 전에 반영된다) | 늦게 반영되면 비우기 시각을 늦추거나(예: 08:00 직전), 장중 한 번 더 비운다. §6.2 |

---

## 13. 열린 질문

1. **키움 점검 시간의 차트.** 캐시를 메모리에만 두므로 서버를 다시 켠 직후나 07:45 비우기 뒤에 키움이 응답하지 않으면 차트가 뜨지 않는다. ADR 0003이 받아들인 비용이다. 실제로 불편해지면 디스크 계층을 다시 붙이는 것을 검토한다. 지금은 결정할 것이 없다.

---

## 14. 용어·ADR 제안

GLOSSARY.md와 ADR은 고치지 않았다. 아래는 제안이다. ADR 0004에 이미 들어간 것(토큰을 발급하는 네 경우, 실측 프로그램도 같은 잠금 파일을 잡는 것)은 지웠다. PR #13이 낸 제안 두 개(장 끝 확정 유예 10초, 지수 봉의 시고저종 보정)는 이 문서 §3.3과 §4.6에 넣었다.

- **기준가**(새 용어 후보, kiwoom.md에서도 제안): 등락의 기준이 되는 가격(보통 전일 종가). 현재가의 `change`가 이것에 기대고 있다(§4.6). 용어집 "정규장 종가" 항목이 이미 이 말을 쓴다. 표제어로 넣기를 제안한다.
- **끊긴 구간**(새 용어 후보): 실시간 연결이 끊겨 체결을 받지 못한 시간. 다시 연결되면 조회로 메운다. ADR 0003이 "실시간 연결이 끊겼던 구간"이라고 풀어 쓰는 개념이다.
- **캐시 구간**(새 용어 후보): (종목, 거래소, 봉 주기)마다 캐시가 빠짐없이 갖고 있는 시각 범위.
- **ADR 0004의 "저장소 루트 `.env`"**: 서버는 `VALLY_ENV_FILE`(절대 경로)로만 설정 파일을 읽는다(§11.1). ADR 문구를 "`VALLY_ENV_FILE`이 가리키는 파일"로 고치기를 제안한다.
- **ADR 0003의 "(종목, 봉 주기)"**: 캐시 단위는 이제 (종목, 거래소, 봉 주기)다(ADR 0007, §2.7). ADR 0003의 "계층"과 "단위" 문구에 거래소를 더하기를 제안한다.
- **decisions-r1 D3 표**: #14(1.5단계: 칸마다 거래소, 분봉 과거 조회) 행이 없고, #4 행에 "분봉"이 남아 있다. 이 문서 §0처럼 고치기를 제안한다.
- **decisions-r1 D16의 첫 "확인됨" 항목**: 차트를 통합 시세로만 그린다는 문구를 D17과 ADR 0007이 바꿨다. D16 항목에 "D17로 바뀜"을 붙이기를 제안한다.
