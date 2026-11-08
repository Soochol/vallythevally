# 백엔드 설계

vallythevally Rust 백엔드의 설계다. 코드는 아직 없다. 이 문서의 Rust 코드 블록은 형태를 보여 주는 스케치이고, 컴파일을 확인한 코드가 아니다.

- 기준 문서: `GLOSSARY.md`, `docs/adr/0001`~`0004`, 이슈 #2~#9(로드맵 #12)
- 키움 동작 중 아직 재지 않은 것은 모두 **[실측]** 으로 표시했다. 기본값은 §12에 모았다. `docs/kiwoom.md`는 이 문서를 쓰는 시점(2026-11-08)에 아직 없어서 반영한 실측 결과는 없다.
- 브라우저 쪽이 기대는 것은 §8 **브라우저 계약**에 모두 들어 있다. 프런트엔드는 §8만 읽으면 된다.

---

## 1. 크레이트 구성과 의존 방향

### 결론

```
vallythevally/
├── Cargo.toml            # workspace
├── crates/
│   ├── domain/           # 순수. 체결·봉·봉 주기·종목코드·시각·현재 봉 집계·알림 판단
│   ├── indicators/       # 순수. 지표 종류 일곱 가지. feature "wasm"으로 브라우저용 빌드
│   └── server/           # 바이너리 하나. Axum + 키움 + Postgres + 실시간 + 알림
├── migrations/           # sqlx 마이그레이션(사용자 자료 스키마 app)
└── web/                  # React (이 문서 범위 밖)
```

```
indicators ──▶ domain
server ──────▶ domain, indicators
web(WASM) ───▶ indicators(feature "wasm")
```

크레이트는 세 개다. 후보였던 `kiwoom`과 `store`는 크레이트로 만들지 않고 `server` 안의 모듈로 둔다.

### 경계마다의 근거

| 경계 | 둔 이유 |
|---|---|
| `domain` 크레이트 | ADR 0003은 봉 집계와 알림 판단을 "체결 목록을 받는 순수 함수"로 만들라고 한다. 별도 크레이트로 두면 `Cargo.toml`에 tokio·sqlx·reqwest가 없으므로 순수성을 **컴파일러가 강제**한다. 시계도 읽지 않는다(현재 시각은 인자로 받는다). 호출자는 `server`와 `indicators` 둘이다. |
| `indicators` 크레이트 | 브라우저(WASM)와 서버(지표 알림)가 같은 코드를 쓴다(ADR 0002). WASM으로 빌드되어야 하므로 IO 의존이 없어야 하고, 호출자가 둘이다. |
| `indicators` → `domain` | 일목균형표 선행스팬처럼 마지막 봉 뒤의 미래 봉 시작 시각이 필요하다. 봉 경계 규칙은 `domain::Period`가 유일한 정의라서, 브라우저도 같은 함수를 WASM으로 받아야 한다(§9). |
| `domain`은 `indicators`를 모른다 | 지표 알림의 판단은 "지표 값 두 쌍이 교차했나"뿐이다. `domain::alert`는 `f64` 값만 받고, 지표 계산은 `server`가 `indicators`로 해서 넘긴다. 그래서 순환이 없다. |
| `kiwoom`은 모듈 | 호출자는 `server` 하나다. 실측 프로그램(#1)은 버릴 코드라 두 번째 호출자로 치지 않는다. 크레이트로 나눠서 얻는 것은 파서 테스트의 빌드 격리 정도인데, 모듈 테스트로 충분하다. 시세 API만 쓰게 하는 장치(§4.4)는 크레이트 경계가 아니라 타입과 테스트로 건다. |
| `store`는 모듈 | 호출자는 `server` 하나다. sqlx의 컴파일 시점 쿼리 검사는 크레이트를 나누지 않아도 된다. |

나중에 두 번째 바이너리가 같은 키움 클라이언트를 써야 하면 그때 `server::kiwoom`을 크레이트로 뺀다. ADR 0004 때문에 토큰을 가진 프로세스는 하나뿐이어야 하므로, 그런 일은 드물 것이다.

### `server` 안의 모듈

깊은 모듈(작은 인터페이스 뒤에 많은 일을 숨기는 모듈)로 나눈다. 바깥에 보이는 것은 각 모듈의 핸들 하나다.

| 모듈 | 바깥에 보이는 것 | 숨기는 것 |
|---|---|---|
| `config` | `Config::from_env()` | `.env` 읽기, 검증, 비밀값 감싸기 |
| `kiwoom::rest` | `KiwoomRest::call(req, priority)` | 토큰, 대기열, 초당 5회, 같은 요청 합치기, 연속조회, 오류 대응 |
| `kiwoom::ws` | `KiwoomStream`(체결 스트림 + 원하는 구독 집합 설정) | LOGIN, PING, REG/REMOVE, 재연결, 재등록 |
| `kiwoom::wire` | 응답 → `domain` 타입 파서 | 부호 붙은 문자열, 필드 번호, 날짜 형식 |
| `bars` | `BarService::page(key, before, limit, priority)` | 메모리 캐시, Postgres 캐시, 캐시 구간, 키움 조회, 수정주가 대조 |
| `market` | `MarketHub`(액터) | 구독 관리자, 현재 봉 집계, 확정, 끊긴 구간 메우기, 브라우저로 내보내기 |
| `alert` | `AlertEngine` | 가격 알림·지표 알림 판단 실행, 반복, 기록 |
| `notify` | `Notifier::send(event)` | 텔레그램, 화면 안 알림 |
| `store::app` | 사용자 자료 저장소 | sqlx 쿼리 |
| `http` | `router(state)` | REST, 브라우저 WebSocket, 정적 파일 |

---

## 2. 핵심 타입과 불변식

원칙: 잘못된 상태를 표현할 수 없게 한다. 외부 자료(키움 응답, 브라우저 JSON, DB 행)는 경계에서 한 번 파싱하고, 안쪽에서는 타입을 믿는다.

### 2.1 종목코드

"통합 시세 고정"을 타입으로 건다. KRX만, NXT만 고르는 값은 아예 없다. 지수는 거래소가 하나라 통합 시세 개념이 없으므로 별도 변형으로 둔다.

```rust
/// KRX 단축코드 6자리. 영문 대문자가 섞일 수 있다(예: 신규 발행 코드). [실측]
#[derive(Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct StockCode([u8; 6]);

impl StockCode {
    pub fn parse(s: &str) -> Result<Self, SymbolError>; // [0-9A-Z]{6}만 허용
    pub fn as_str(&self) -> &str;
}

/// 키움 업종코드. 코스피 "001", 코스닥 "101". [실측]
#[derive(Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct IndexCode([u8; 3]);

#[derive(Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Symbol {
    /// 주식(우선주·리츠 포함)과 ETF. 시세는 언제나 통합 시세다.
    Stock(StockCode),
    Index(IndexCode),
}

impl Symbol {
    /// 브라우저와 DB에서 쓰는 문자열. 주식 "005930", 지수 "IDX:001".
    pub fn parse(s: &str) -> Result<Self, SymbolError>;
    pub fn as_wire(&self) -> String;
}
```

키움에 보낼 코드(`005930_AL` 같은 통합 시세 접미사)는 `domain`에 두지 않는다. `server::kiwoom::wire`의 함수 하나가 만들고, 접미사를 만드는 곳은 거기뿐이다.

```rust
// server::kiwoom::wire
fn kiwoom_stock_code(code: StockCode) -> String; // "005930_AL" [실측: 차트 조회에도 _AL이 통하는지]
```

종목 정보(목록·검색용)는 따로 둔다.

```rust
pub enum SymbolKind { Common, Preferred, Reit, Etf, Index }
pub enum Market { Kospi, Kosdaq }

pub struct SymbolInfo {
    pub symbol: Symbol,
    pub name: String,
    pub kind: SymbolKind,
    pub market: Market,
}
```

### 2.2 가격과 수량

`f64`를 체결과 봉에 넣지 않는다. 주식 가격은 원 단위 정수, 지수는 소수 둘째 자리까지다. 둘을 한 타입으로 받으려고 **0.01 단위 정수**로 둔다. 주식 가격은 언제나 100의 배수가 된다.

```rust
/// 0.01 단위 가격. 주식 71,500원 → Price(7_150_000), 코스피 2,512.34 → Price(251_234).
/// 0보다 크다.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Price(NonZeroU64);

impl Price {
    pub fn from_centi(v: u64) -> Option<Self>;
    pub fn to_f64(self) -> f64; // 지표 계산과 브라우저 전송에만 쓴다
}

/// 체결 수량 또는 봉 거래량. 부호가 없다.
/// 0B의 체결량은 매수/매도를 부호로 나타내지만, 파서에서 절댓값으로 바꾼다.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Default)]
pub struct Volume(u64);
```

### 2.3 시각

KST는 1988년 이후 서머타임이 없어서 고정 오프셋(+09:00)으로 충분하다. 시간대 데이터베이스가 필요 없다.

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

### 2.4 봉 주기

```rust
#[derive(Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Period { M1, M3, M5, M15, M30, M60, Day, Week, Month }

impl Period {
    pub const ALL: [Period; 9];
    pub fn as_wire(self) -> &'static str;          // "1m" "3m" "5m" "15m" "30m" "60m" "D" "W" "M"
    pub fn parse(s: &str) -> Result<Self, PeriodError>;

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
    /// 이 봉이 확정되는 시각. §3.3.
    pub fn confirm_at(self) -> KstTime;
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
}
```

0B에는 체결시간(HHMMSS)만 있고 날짜가 없다. `Trade`는 날짜가 정해진 뒤에만 만들 수 있다(§3.1의 `resolve_trade_time`).

### 2.6 봉, 확정 봉, 현재 봉, 출처

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

/// 봉의 출처.
#[derive(Clone, Copy, PartialEq, Eq)]
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
}

/// 현재 봉. 출처 필드가 없다(언제나 서버가 체결로 만든다).
/// 캐시 저장 함수는 ConfirmedBar만 받으므로, 현재 봉은 타입 수준에서 캐시에 들어갈 수 없다(ADR 0003).
pub struct CurrentBar {
    bucket: Bucket,
    ohlcv: Ohlcv,
    /// 이 시각까지의 체결은 이미 반영되어 있다. 키움 조회값으로 시드했을 때 중복 반영을 막는다.
    counted_through: KstTime,
}
```

브라우저로 보낼 때는 확정 봉과 현재 봉을 같은 JSON 모양(§8의 `Bar`)으로 보내고, 메시지 종류로 구분한다.

### 2.7 캐시 키

```rust
#[derive(Clone, Copy, PartialEq, Eq, Hash)]
pub struct SeriesKey { pub symbol: Symbol, pub period: Period }
```

---

## 3. 시간 모델

### 3.1 0B 체결시간에 날짜 정하기

체결은 평일 08:00~20:00에만 들어온다(NXT 프리마켓 08:00~08:50, KRX 정규장 09:00~15:30, NXT 애프터마켓 15:40~20:00). 자정을 넘는 체결이 없으므로 **수신 시각의 KST 날짜**를 붙이면 된다. 시계가 어긋난 경우를 걸러 내기 위해 검사를 둔다.

```rust
pub const TRADING_OPEN: TimeOfDay;  // 08:00:00
pub const TRADING_CLOSE: TimeOfDay; // 20:00:00 (포함)

pub enum TradeTimeError {
    /// 08:00:00 ~ 20:00:00 밖.
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
- 걸러진 체결은 버리고 종류별 카운터와 `warn` 로그를 남긴다. 현재 봉에는 영향을 주지 않는다. 그 구간의 확정 봉은 나중에 키움 조회로 바로잡힌다.
- 공휴일인지는 따지지 않는다. 체결이 오면 받는다.

키움 차트 조회 응답(ka10080 `cntr_tm`, ka10081 `dt` 등)은 날짜가 들어 있으므로 추론하지 않는다. [실측: 형식 `YYYYMMDDHHMMSS`]

### 3.2 봉 경계

모든 경계는 KST 기준이다.

| 봉 주기 | 봉 시작 시각 | 끝(배타) |
|---|---|---|
| 1·3·5·15·30·60분 | KST 자정부터 n분 단위로 자른 경계(예: 5분봉 09:05, 09:10) | 시작 + n분 |
| 일 | 그 날짜 00:00 KST | 다음 날 00:00 |
| 주 | 그 주 월요일 00:00 KST | 다음 주 월요일 00:00 |
| 월 | 그 달 1일 00:00 KST | 다음 달 1일 00:00 |

- **08:00 기준이냐 09:00 기준이냐**: 우리 봉 주기(1·3·5·15·30·60분)는 모두 60분의 약수다. 그래서 08:00에서 자르든 09:00에서 자르든 정시에서 자르든 경계가 같다. 이 질문은 10분·45분 같은 봉 주기를 넣을 때만 의미가 생긴다. 남은 실측 질문은 다음과 같다. **[실측]**
  - 키움 분봉 시각이 봉 **시작**을 가리키는지 **끝**을 가리키는지. 기본값: 시작. 끝이면 파서에서 한 봉 주기를 뺀다.
  - 키움 60분봉이 정시(08:00, 09:00, …)에 잘리는지. 정시가 아니면(예: 09:00 시작 기준 15:00~15:30처럼 30분 봉이 생기는 경우) 위 표를 바꾼다.
  - 15:30 종가 단일가 체결과 20:00 마지막 체결이 어느 분봉에 들어가는지. 기본값: 체결 시각이 속한 구간(15:30 봉, 20:00 봉).
- 일·주·월봉의 시작 시각은 키움이 준 날짜와 상관없이 위 규칙으로 다시 맞춘다. 예를 들어 키움 주봉 날짜가 그 주에 체결이 있었던 첫날이든 마지막 날이든 `Period::Week.bucket(그 날짜)`로 월요일 00:00이 된다. [실측: 키움 주봉·월봉 날짜가 무엇을 가리키는지]
- 체결이 없는 분은 봉을 만들지 않는다. 빈 봉을 채우지 않는다. [실측: 키움도 빈 분을 건너뛰는지]

### 3.3 봉 확정 시각

현재 봉은 다음 구간의 체결이 오거나, 아래 확정 시각이 지나면 확정된다. 확정 시각은 서버의 1초 타이머가 `now`를 넘겨 판단한다.

| 봉 주기 | 확정 시각 |
|---|---|
| 분봉 | 구간 끝 + 2초(늦게 도착하는 체결 유예) |
| 일 | 그날 20:00:00 + 2초 |
| 주 | 그 주 금요일 20:00:00 + 2초 |
| 월 | 그 달 마지막 평일 20:00:00 + 2초 |

주말에는 체결이 없으므로 "금요일 20:00"은 휴장일 달력 없이도 맞다. 금요일이 공휴일이면 그 주의 마지막 체결은 이미 들어와 있으므로 같은 시각에 확정해도 결과가 같다.

확정 뒤에 그 구간 체결시간을 단 체결이 오면(늦은 체결) 현재 봉에 넣지 않고 카운터만 올린다. 확정 봉은 나중에 키움 값으로 교체된다.

### 3.4 강제 단절 시각

키움은 매일 07:50(일요일 05:00)에 WebSocket을 끊는다(#4). 07:50은 체결이 없는 시간이라 현재 봉에는 영향이 없다. 다시 연결하고 다시 등록하는 절차는 일반 단절과 같다(§5.2).

---

## 4. 키움 클라이언트 (ADR 0004)

### 4.1 토큰

```rust
pub struct TokenHolder { /* Mutex<Option<IssuedToken>>, 발급 single-flight */ }

struct IssuedToken {
    token: Secret<String>,
    expires_at: KstTime, // au10001 응답 expires_dt
}

impl TokenHolder {
    /// 유효한 토큰을 준다. 만료 10분 전부터만 다시 발급한다. 동시에 불러도 발급은 한 번이다.
    pub async fn get(&self) -> Result<Secret<String>, AuthError>;
    /// 토큰 무효 응답을 받았을 때만 부른다. 5분 안에 두 번째로 부르면 다시 발급하지 않고 실패한다.
    pub async fn invalidate_and_reissue(&self, seen: &Secret<String>) -> Result<Secret<String>, AuthError>;
}
```

- 실계좌 키 하나만 쓴다(`VALLY_KIWOOM_APP_KEY`, `VALLY_KIWOOM_APP_SECRET`). 모의 키 설정은 없다.
- **토큰을 가진 프로세스는 하나**: 서버가 뜰 때 Postgres advisory lock(`pg_try_advisory_lock`)을 잡는다. 못 잡으면 같은 DB를 쓰는 서버가 이미 떠 있는 것이므로 바로 종료한다. 실측 프로그램과 동시에 돌리지 않는 것은 운영 규칙이다(ADR 0004). 서버가 이를 막을 방법은 없다.
- 토큰은 메모리에만 둔다. 서버를 다시 켜면 새로 발급한다. 재시작은 드물어서 받아들인다. 디스크에 보관할지는 열린 질문이다(§13).
- 토큰 폐기(au10002)는 허용 목록에 넣지 않는다. 폐기할 일이 없다.
- `invalidate_and_reissue`는 `seen`이 지금 가진 토큰과 같을 때만 다시 발급한다. 여러 요청이 동시에 무효 응답을 받아도 발급은 한 번이다.

### 4.2 조회 대기열

```rust
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Priority {
    /// 브라우저가 기다리는 요청: 봉 페이지, 종목을 처음 열 때의 수정주가 대조.
    Screen,
    /// 끊긴 구간 메우기, 관심종목 현재가 1분 조회, 종목 목록 갱신, 실시간으로 만든 봉 정리.
    Background,
}

pub struct KiwoomRest { /* TokenHolder, 대기열 두 개, 진행 중 요청 표 */ }

impl KiwoomRest {
    /// 한 페이지를 받는다. 연속조회 키가 있으면 다음 페이지를 이어 받는다.
    pub async fn call<R: MarketRequest>(&self, req: &R, cont: Option<ContKey>, priority: Priority)
        -> Result<Page<R::Response>, KiwoomError>;
}

pub struct Page<T> { pub body: T, pub next: Option<ContKey> }
/// 응답 헤더 cont-yn=Y 일 때의 next-key.
pub struct ContKey(String);
```

- **속도**: 서버 전체의 키움 조회를 대기열 하나가 내보낸다. 요청 사이를 최소 210ms 띄워 초당 5회를 넘지 않게 한다(경계에서 6회로 세지는 것을 막는 여유). 토큰 발급(au10001)도 이 대기열의 속도 제한을 따르지만, 토큰을 얻는 단계는 건너뛴다(그러지 않으면 토큰을 얻으려고 토큰이 필요해진다). 토큰 발급은 다른 요청보다 먼저 나간다.
- **우선순위**: 내보낼 차례가 오면 `Screen` 대기열부터 꺼낸다. `Background`는 `Screen`이 비었을 때만 나간다. 사용자가 한 명이라 `Background`가 오래 굶을 일은 적다.
- **같은 요청은 한 번만**: 진행 중 요청 표의 키는 `(api-id, 정규화한 요청 본문, 연속조회 키)`다. 같은 키가 대기열에 있거나 응답을 기다리는 중이면 새로 넣지 않고 같은 결과를 나눠 받는다(`futures::future::Shared`). 이미 들어간 요청보다 높은 우선순위로 같은 요청이 오면 그 요청을 `Screen`으로 올린다.
- **연속조회**: 한 페이지가 대기열의 한 칸이다. 다음 페이지를 이어 받을지는 호출자(`bars`)가 정한다. 이어지는 페이지는 앞 페이지의 우선순위를 물려받는다. [실측: 연속조회 키가 얼마 동안 유효한지, 분봉을 과거 어디까지 받을 수 있는지]

### 4.3 오류 코드별 대응

키움은 HTTP 200 안에 `return_code`/`return_msg`로 오류를 준다. 아래 번호는 공개 문서에서 본 기본 해석이고 **[실측]** 대상이다. 확정 번호는 `docs/kiwoom.md`를 따른다.

| 상황 | 응답 코드(기본 해석) | 대응 |
|---|---|---|
| 요청 개수 초과 | `return_code` 1700, HTTP 429 | 같은 요청을 그 대기열 맨 앞에 다시 넣고, 대기열 전체를 1초 멈춘다. 같은 요청이 3번 연속 걸리면 실패로 돌려준다. 간격 210ms를 늘려야 한다는 뜻이므로 `warn` 로그를 남긴다. |
| 토큰 무효·만료 | 8005, HTTP 401 | `invalidate_and_reissue` 한 번, 그다음 같은 요청을 한 번 다시 보낸다. 그래도 실패하면 `AuthFailed`. |
| 앱키·IP·투자구분 인증 실패 | 8001, 8002, 8030, 8031, 8050, 8103 등 8xxx | 되돌릴 수 없는 설정 문제다. 모든 조회와 실시간을 멈추고, 상태를 `auth_failed`로 바꿔 브라우저에 알린다. 다시 발급을 반복하지 않는다. 운영자가 고치고 서버를 다시 켠다. |
| 잘못된 요청(필수값 누락, 없는 종목) | 15xx, 19xx | 다시 보내지 않는다. 브라우저에는 `bad_request` 또는 `unknown_symbol`. |
| 네트워크 오류, HTTP 5xx | — | `Screen`: 0.5초 뒤 한 번만 다시 보내고, 실패하면 오류를 돌려준다. `Background`: 1·2·4초 간격으로 세 번까지. |
| 응답 파싱 실패 | — | 다시 보내지 않는다. 응답 원문 앞 2KB를 `error` 로그로 남긴다(토큰·키가 들어 있지 않은 응답만; §11.3). |

```rust
pub enum KiwoomError {
    RateLimited,
    AuthFailed { code: i32 },
    BadRequest { code: i32, msg: String },
    UnknownSymbol,
    Transport(String),   // URL과 헤더를 뺀 설명
    Parse { api_id: ApiId, detail: String },
}
```

### 4.4 시세 API만 허용

실계좌 키는 주문도 넣을 수 있다. 그래서 시세 API 외에는 **표현할 수 없게** 만든다.

```rust
/// 허용 목록. 이 enum에 없는 api-id는 보낼 수 없다.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum ApiId {
    Au10001, // 접근토큰 발급              /oauth2/token
    Ka10099, // 종목정보 리스트            /api/dostk/stkinfo
    Ka10095, // 관심종목정보(여러 종목 현재가) /api/dostk/stkinfo  [실측]
    Ka10080, // 주식 분봉                  /api/dostk/chart
    Ka10081, // 주식 일봉                  /api/dostk/chart
    Ka10082, // 주식 주봉                  /api/dostk/chart
    Ka10083, // 주식 월봉                  /api/dostk/chart
    Ka20005, // 업종 분봉                  /api/dostk/chart  [실측]
    Ka20006, // 업종 일봉                  /api/dostk/chart
    Ka20007, // 업종 주봉                  /api/dostk/chart  [실측]
    Ka20008, // 업종 월봉                  /api/dostk/chart  [실측]
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
- 실시간 등록 타입도 허용 목록이다: `0B`(주식체결), `0J`(업종지수). 주문체결(`00`), 잔고(`04`) 같은 계좌 실시간은 enum에 없다.
- **구조 검사 테스트**: `server/src` 전체에서 `/api/dostk/ordr`, `/api/dostk/acnt`, `kt1`로 시작하는 api-id 문자열이 나오면 실패하는 테스트를 둔다. 누가 실수로 주문 API를 넣으면 CI가 막는다.

### 4.5 요청 타입 예시

```rust
#[derive(Serialize)]
pub struct MinuteChart {          // ka10080
    stk_cd: String,               // kiwoom_stock_code(...)로만 만든다
    tic_scope: &'static str,      // "1" "3" "5" "15" "30" "60"
    upd_stkpc_tp: &'static str,   // 언제나 "1"(수정주가)
}
impl sealed::Sealed for MinuteChart {}
impl MarketRequest for MinuteChart {
    const API_ID: ApiId = ApiId::Ka10080;
    type Response = wire::MinuteChartResponse;
}

impl MinuteChart {
    pub fn new(code: StockCode, period: Period) -> Option<Self>; // 분봉이 아니면 None
}
```

파서는 응답 타입을 `domain` 타입으로 바꾼다. 부호 붙은 가격(`"+71500"`, `"-71500"`)은 절댓값으로, 0.01 단위로 바꾼다.

```rust
// server::kiwoom::wire
pub fn parse_chart_bars(resp: &MinuteChartResponse, period: Period) -> Result<Vec<KiwoomBar>, WireError>;

/// 키움에서 받은 봉. 마지막 봉은 진행 중인 구간일 수 있다.
pub struct KiwoomBar { pub bucket: Bucket, pub ohlcv: Ohlcv }

pub fn parse_real_0b(values: &RealValues, received_at: KstTime) -> Result<Trade, WireError>;
pub fn parse_real_0j(values: &RealValues, received_at: KstTime, prev_cum: Option<Volume>) -> Result<Trade, WireError>;
```

---

## 5. 실시간

### 5.1 WebSocket 세션

토큰 하나에 세션 하나다(공지 49). 서버 안에서도 세션은 언제나 하나다.

```rust
enum SessionState {
    Disconnected { since: KstTime, retry_at: KstTime, attempt: u32 },
    Connecting,
    LoggingIn,
    Live { since: KstTime, session: SessionId },
    /// 인증 실패. 운영자가 고칠 때까지 다시 연결하지 않는다.
    Halted,
}

pub struct KiwoomStream { /* 내부 태스크 하나 */ }

impl KiwoomStream {
    /// 구독해야 할 전체 집합을 통째로 준다. 세션이 차이를 계산해 REG/REMOVE를 보낸다.
    pub fn set_desired(&self, desired: BTreeSet<Symbol>);
    pub fn events(&self) -> mpsc::Receiver<StreamEvent>;
}

pub enum StreamEvent {
    Trade { symbol: Symbol, trade: Trade },
    /// 세션이 Live가 되고 원하는 집합을 모두 등록했다.
    Live { session: SessionId, since: KstTime },
    /// 세션이 끊겼다. 이 시각부터 다음 Live까지는 체결이 빠졌을 수 있다.
    Down { at: KstTime },
    Halted,
}
```

- 주소: `wss://api.kiwoom.com:10000/api/dostk/websocket` [실측]
- **LOGIN**: 연결 직후 `{"trnm":"LOGIN","token":…}`. 성공 응답을 받아야 `Live`로 간다. 실패 코드가 인증 실패(§4.3)면 토큰을 한 번 다시 받아 재시도하고, 또 실패하면 `Halted`.
- **PING**: 서버가 보낸 `{"trnm":"PING",…}`를 받은 그대로 돌려보낸다.
- **REG/REMOVE**: `set_desired`로 받은 집합과 등록된 집합의 차이만 보낸다. 한 메시지에 최대 100종목씩 나눠 보낸다 [실측]. 그룹 번호는 하나(`grp_no: "1"`)만 쓰고, 처음 REG는 `refresh: "1"`(기존 등록 유지)로 보낸다.
- 주식은 `0B`, 지수는 `0J`로 등록한다. 등록 코드는 `kiwoom_stock_code`가 만든다.
- **REAL**: `data[]`의 각 항목을 `parse_real_0b/0j`로 `Trade`로 바꾼다. 실패한 항목은 버리고 카운터를 올린다.

### 5.2 다시 연결, 다시 등록, 끊긴 구간 메우기

- 끊기면 1·2·5·10·30초 간격으로 다시 연결한다(이후 30초 고정). 07:50 강제 단절도 같은 경로다.
- 다시 연결되면 LOGIN → 원하는 집합 전체를 다시 REG → `StreamEvent::Live`를 보낸다.
- `MarketHub`는 `Down { at }`과 그다음 `Live { since }` 사이를 **끊긴 구간**으로 본다.
  1. 끊긴 동안의 현재 봉은 믿을 수 없다. 끊긴 구간이 체결 시간(08:00~20:00)과 겹치면, 열려 있는 모든 `SeriesKey`에 대해 `BarService::refresh_latest(key, Priority::Background)`를 넣는다(§6.4).
  2. 결과로 받은 확정 봉이 캐시의 실시간으로 만든 봉을 덮어쓰고, 진행 중 구간의 봉은 현재 봉의 새 시드가 된다.
  3. 브라우저에 `reload` 메시지(§8.3)를 보낸다.
- 끊긴 구간이 체결 시간과 겹치지 않으면(07:50 단절이 대개 그렇다) 메울 것이 없다. 다시 등록만 한다.

### 5.3 구독 관리자

키움 구독 단위는 **종목**이다. 브라우저 구독 단위는 **(종목, 봉 주기)** 다. 서버가 종목 하나의 체결을 그 종목의 모든 봉 주기 집계기로 나눠 보낸다.

```rust
/// 누가 이 종목의 실시간 구독을 잡고 있는가.
#[derive(Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Holder {
    /// 브라우저 연결 하나의 구독 하나. 칸의 주 종목과 비교 종목 모두 여기에 든다.
    Pane { conn: ConnId, sub: SubId },
    Watchlist,
    Alert(AlertId),
}

pub struct SubscriptionManager {
    holders: BTreeMap<Symbol, BTreeSet<Holder>>,
    /// 보유자가 모두 빠진 시각. 30초 뒤 해지 후보.
    released_at: BTreeMap<Symbol, KstTime>,
}

pub const RELEASE_GRACE_SECS: i64 = 30;
pub const REALTIME_LIMIT: usize = 200;

pub struct Plan {
    /// 키움에 등록할 집합. 크기 ≤ 200.
    pub realtime: BTreeSet<Symbol>,
    /// 한도를 넘어 1분마다 조회로 현재가를 받을 관심종목.
    pub polled: BTreeSet<Symbol>,
    /// 한도를 넘어 받을 수 없는 칸·알림 구독. 브라우저에 오류를 돌려준다.
    pub rejected: BTreeSet<Holder>,
}

impl SubscriptionManager {
    pub fn hold(&mut self, symbol: Symbol, h: Holder);
    pub fn release(&mut self, symbol: Symbol, h: &Holder, now: KstTime);
    pub fn release_conn(&mut self, conn: ConnId, now: KstTime); // 연결이 끊긴 브라우저
    /// 순수 함수. 같은 상태와 now면 언제나 같은 계획.
    pub fn plan(&self, now: KstTime) -> Plan;
}
```

`plan`의 규칙:

1. 보유자가 하나라도 있거나, 마지막 보유자가 빠진 지 30초가 안 된 종목이 후보다.
2. 후보를 우선순위로 정렬한다: 칸 > 알림 > 관심종목만 잡은 종목. 같은 우선순위 안에서는 30초 유예 중인 종목이 가장 뒤, 그다음은 종목코드 순서다.
3. 앞에서부터 200개를 `realtime`에 넣는다.
4. 넘친 것 중 관심종목만 잡은 종목은 `polled`로 간다. 1분마다 `Ka10095`로 한 번에 묶어 조회한다(`Background`).
5. 넘친 것 중 칸·알림이 잡은 종목은 `rejected`. 칸이면 브라우저에 `sub_error { code: "realtime_limit" }`, 알림이면 알림 목록에 경고를 띄운다. 칸과 알림만으로 200을 넘는 일은 개인 사용에서는 드물다.

`MarketHub`는 보유자가 바뀔 때와 1초 타이머마다 `plan`을 다시 계산해서, `realtime`이 바뀌었으면 `KiwoomStream::set_desired`를 부른다.

관심종목 현재가는 실시간 구독이든 조회든 같은 `quote` 메시지로 브라우저에 간다(§8.3). `source` 필드로 어느 쪽인지 알린다.

### 5.4 현재 봉 집계(순수 함수, `domain::aggregate`)

```rust
pub enum Applied {
    /// 현재 봉에 더했다.
    Updated,
    /// 새 구간의 체결이라 앞 봉을 확정하고 새 현재 봉을 시작했다.
    Rolled { confirmed: ConfirmedBar },
    /// 이미 반영된 체결이거나(counted_through 이전), 확정이 끝난 구간의 체결이다.
    Ignored(IgnoreReason),
}

impl CurrentBar {
    /// 키움 조회에서 받은 진행 중 구간의 봉으로 시작한다. as_of는 조회 응답을 받은 시각.
    pub fn seed(bar: KiwoomBar, as_of: KstTime) -> Self;
    pub fn bucket(&self) -> Bucket;
    pub fn ohlcv(&self) -> &Ohlcv;
}

/// 체결 하나를 반영한다. state가 None이면 이 체결로 새 현재 봉을 시작한다.
pub fn apply_trade(state: &mut Option<CurrentBar>, period: Period, trade: &Trade) -> Applied;

/// 확정 시각이 지났으면 현재 봉을 확정하고 비운다.
pub fn close_if_due(state: &mut Option<CurrentBar>, now: KstTime) -> Option<ConfirmedBar>;

/// 테스트와 리플레이 없는 검증용: 체결 목록 전체를 접는다.
pub fn aggregate(period: Period, seed: Option<CurrentBar>, trades: &[Trade], now: KstTime)
    -> (Vec<ConfirmedBar>, Option<CurrentBar>);
```

- 체결 하나는 그 종목의 열린 봉 주기 집계기 모두에 들어간다. 일·주·월봉 현재 봉도 체결로 만든다. 이것은 다른 봉 주기의 봉에서 파생하는 것이 아니다. ADR 0003이 금지한 것은 키움 확정 봉을 다른 봉 주기에서 파생하는 것이다.
- 시드: 종목을 처음 열 때 받은 키움 조회의 마지막 봉이 진행 중 구간이면 그것이 시드다. `counted_through`(= 조회 응답 받은 시각)보다 이른 체결은 이미 들어 있으므로 버린다. 같은 초에 들어온 체결은 약간 겹치거나 빠질 수 있다. 이 오차는 확정 뒤 키움 값으로 교체될 때 사라진다.
- 실시간 구독을 조회보다 **먼저** 등록한다. 등록과 조회 사이에 들어온 체결은 집계기 앞에 쌓아 두었다가 시드가 오면 `counted_through` 이후 것만 반영한다.
- 일봉 현재 봉을 0B의 당일 시가·고가·저가·누적거래량 필드로 바로 만드는 방법도 있다. 통합 시세(`_AL`)에서 이 필드가 KRX+NXT 합계인지 확인되면 일봉만 이 방법으로 바꿀 수 있다. [실측]

### 5.5 `MarketHub` 액터

실시간 상태는 태스크 하나가 혼자 가진다. 락이 없다.

```rust
enum HubInput {
    Stream(StreamEvent),
    Tick(KstTime),                                       // 1초마다
    Subscribe { conn: ConnId, sub: SubId, key: SeriesKey, reply: oneshot::Sender<SubscribeReply> },
    Unsubscribe { conn: ConnId, sub: SubId },
    ConnClosed(ConnId),
    Seeded { key: SeriesKey, seed: Option<KiwoomBar>, as_of: KstTime },
    WatchlistChanged(BTreeSet<Symbol>),
    AlertsChanged(Vec<AlertSpec>),
    Polled(Vec<Quote>),
}
```

한 체결이 들어오면: 가격 알림 판단 → 그 종목의 각 `SeriesKey` 집계기에 `apply_trade` → `Rolled`면 확정 봉을 `BarService::append_realtime`으로 넘기고 지표 알림 판단 → 그 키를 구독한 브라우저 구독들에 갱신 표시. 브라우저로 실제로 보내는 일은 연결마다의 쓰기 태스크가 한다(§8.4).

---

## 6. 캐시 (ADR 0003)

### 6.1 저장 위치

| 계층 | 내용 | 수명 |
|---|---|---|
| 서버 메모리 | 열려 있는 `SeriesKey`의 확정 봉 `Vec<ConfirmedBar>`와 캐시 구간 | 보유자가 사라지고 10분 뒤 메모리에서만 내린다 |
| Postgres `cache` 스키마 | 확정 봉, 캐시 구간, 종목 목록, 수정주가 대조 기록 | 언제 통째로 지워도 된다 |
| 브라우저 메모리 | §8 참고 | 탭 수명 |

현재 봉은 어디에도 캐시하지 않는다(`ConfirmedBar`만 저장 함수에 들어간다).

### 6.2 캐시 스키마

`cache` 스키마는 sqlx 마이그레이션을 쓰지 않는다. 서버 코드에 DDL 하나와 `CACHE_SCHEMA_VERSION` 상수를 둔다.

```sql
CREATE SCHEMA cache;

CREATE TABLE cache.meta (
  version integer NOT NULL
);

CREATE TABLE cache.bars (
  symbol   text     NOT NULL,          -- Symbol::as_wire()
  period   text     NOT NULL,          -- Period::as_wire()
  t        bigint   NOT NULL,          -- 봉 시작 시각, Unix 초
  open     bigint   NOT NULL,          -- 0.01 단위
  high     bigint   NOT NULL,
  low      bigint   NOT NULL,
  close    bigint   NOT NULL,
  volume   bigint   NOT NULL,
  source   smallint NOT NULL,          -- 0 = Kiwoom, 1 = Realtime
  PRIMARY KEY (symbol, period, t)
);

-- 캐시 구간. SeriesKey마다 한 줄 = 구간 하나.
CREATE TABLE cache.coverage (
  symbol          text    NOT NULL,
  period          text    NOT NULL,
  oldest_t        bigint  NOT NULL,     -- 구간 시작(포함)
  newest_t        bigint  NOT NULL,     -- 구간 끝(포함)
  kiwoom_newest_t bigint  NOT NULL,     -- 키움에서 받은 봉 중 가장 늦은 것
  reached_origin  boolean NOT NULL,     -- 키움이 더 과거를 주지 않는다
  PRIMARY KEY (symbol, period)
);

CREATE TABLE cache.symbols (
  symbol text PRIMARY KEY, name text NOT NULL, kind text NOT NULL, market text NOT NULL
);
CREATE TABLE cache.symbols_fetched (fetched_on date NOT NULL);

-- 그날 수정주가 대조를 했는지
CREATE TABLE cache.adjust_checked (
  symbol text PRIMARY KEY, checked_on date NOT NULL
);
```

- **캐시 키**: `(symbol, period)`. 봉 하나의 키는 `(symbol, period, t)`.
- **스키마가 바뀌면 지우고 다시 받는다**: 서버가 뜰 때 `cache.meta.version`이 `CACHE_SCHEMA_VERSION`과 다르면(또는 스키마가 없으면) `DROP SCHEMA cache CASCADE` 뒤 DDL을 다시 실행한다. 마이그레이션을 쓰지 않는 이유가 이것이다. 캐시는 옮길 가치가 없다.

### 6.3 구간이 끊기지 않게 하기

**불변식**: `SeriesKey`마다 캐시 구간은 하나다. `[oldest_t, newest_t]` 안에서 키움에 있는 확정 봉은 캐시에도 모두 있다. 구간 밖의 봉은 캐시에 없다.

- 구간은 양 끝으로만 늘어난다. 구간 사이에 구멍이 생기는 쓰기는 하지 않는다.
- 봉 쓰기와 `coverage` 갱신은 한 트랜잭션이다.
- **과거로 늘리기**(스크롤): `oldest_t` 바로 앞부터 받는다. 받은 봉의 가장 늦은 것이 `oldest_t`와 겹치거나 맞닿아야 붙인다.
  - 일·주·월봉은 기준일자 인자로 원하는 지점에서 시작할 수 있다(ka10081 `base_dt`).
  - 분봉에 기준 시각 인자가 없으면 최신부터 연속조회를 따라 내려가야 한다. 그러면 과거 스크롤이 비싸진다. 기본값: 마지막 연속조회 키를 메모리에 기억해 두었다가 이어 받는다. 키가 만료되었으면 처음부터 다시 따라간다. [실측]
  - 키움이 더 줄 것이 없으면 `reached_origin = true`.
- **앞으로 늘리기**(최신으로 따라잡기): 최신 페이지부터 받아서 과거로 연속조회하다가, 받은 봉이 `kiwoom_newest_t`에 닿으면 멈춘다. 이렇게 하면 사이의 실시간으로 만든 봉이 모두 키움 값으로 교체된다. 연속조회가 끝까지 가도 닿지 않으면(분봉 보관 기간을 넘은 경우) 그 키의 캐시를 버리고 받은 것으로 새 구간을 만든다.
- **실시간으로 만든 봉 붙이기**(`append_realtime`): 봉 시작 시각이 `newest_t`보다 늦고, 키움 세션이 `newest_t`의 확정 시각 이전부터 지금까지 한 번도 끊기지 않았을 때만 붙인다. 끊겼으면 붙이지 않고 앞으로 늘리기를 예약한다. 이 조건이 없으면 끊긴 동안의 봉이 빠진 채로 구간이 늘어나 불변식이 깨진다.

```rust
pub struct BarService { /* KiwoomRest, PgPool, 메모리 맵, 키별 single-flight */ }

pub struct BarPage {
    pub bars: Vec<ConfirmedBar>,      // 오름차순, before 보다 이른 것
    pub next_before: Option<KstTime>, // None이면 더 과거가 없다
    pub current: Option<CurrentBar>,  // before가 없을 때만. MarketHub에서 받은 스냅숏
}

impl BarService {
    /// before가 None이면 최신 페이지. 요청 범위가 캐시 구간 안이면 메모리나 Postgres에서 바로 돌려주고
    /// 키움을 기다리지 않는다. 구간 밖일 때만 키움에서 받아 구간을 늘린다.
    pub async fn page(&self, key: SeriesKey, before: Option<KstTime>, limit: usize, prio: Priority)
        -> Result<BarPage, BarError>;
    /// 최신으로 따라잡기. 끊긴 구간 메우기와 재시작 뒤 첫 조회가 쓴다. 진행 중 구간의 봉을 돌려준다.
    pub async fn refresh_latest(&self, key: SeriesKey, prio: Priority) -> Result<Option<KiwoomBar>, BarError>;
    pub async fn append_realtime(&self, key: SeriesKey, bar: ConfirmedBar, live_since: KstTime);
}
```

- **재시작 뒤 첫 조회**(#2 완료 조건 "서버를 다시 켜도 캐시에서 바로 뜬다"): 최신 페이지 요청이 와도 Postgres의 캐시 구간에서 바로 돌려준다. 앞으로 늘리기(`refresh_latest`)와 현재 봉 시드는 요청 경로 밖에서 돈다. 끝나면 새 봉이 `reload { reason: "gap_filled" }`와 `bar` 메시지로 브라우저에 간다. 단, 그날 처음 여는 종목이면 수정주가 대조(§6.5) 한 번은 요청 경로에서 기다린다(대조 결과에 따라 캐시를 버려야 하므로).
- 같은 `SeriesKey`에 대한 키움 조회는 키별 single-flight로 한 번만 돈다. 칸 네 개가 같은 종목을 동시에 열어도 키움에는 한 번 간다.

### 6.4 출처 교체

- 키움에서 받은 봉은 언제나 `source = Kiwoom`으로 upsert한다. 같은 `(symbol, period, t)`의 실시간으로 만든 봉을 덮어쓴다.
- 실시간으로 만든 봉이 키움 값으로 바뀌는 때:
  1. 끊긴 구간 메우기(§5.2).
  2. 서버 재시작이나 메모리에서 내린 뒤 다시 열 때의 앞으로 늘리기(§6.3).
  3. 매일 20:05에 열려 있는 키와 켜진 알림의 키에 대해 `refresh_latest(Background)`. 그날 실시간으로 만든 봉을 그날 안에 정리한다.
- 교체된 봉이 브라우저가 이미 받은 봉이면 `reload` 메시지로 알린다(§8.3).

### 6.5 수정주가

- 그날(KST 날짜) 처음으로 어떤 종목의 봉을 요청받으면(`cache.adjust_checked.checked_on < 오늘`), 그 종목의 일봉 최신 페이지를 `Screen`으로 받는다. 이 응답은 일봉 캐시 따라잡기와 일봉 현재 봉 시드에도 그대로 쓴다.
- 응답 중 **가장 최근 확정 일봉**(오늘이 아닌 가장 늦은 날)을 캐시의 같은 봉과 비교한다. OHLCV 중 하나라도 다르면 그 종목의 캐시를 모든 봉 주기에서 버린다(메모리와 Postgres 모두). 그 종목을 구독한 브라우저에 `reload { reason: "adjusted" }`를 보낸다.
- 캐시에 그 일봉이 없으면 대조할 것이 없으므로 통과로 본다.
- 대조가 끝나면 `checked_on = 오늘`.
- 비교 대상 일봉이 실시간으로 만든 봉이면 비교하지 않고 키움 값으로 교체만 한다(실시간으로 만든 봉은 원래 다를 수 있다).

### 6.6 조회 범위

- 처음 열 때: 최근 500봉(`limit` 기본 500). 키움 한 페이지에 몇 봉이 오는지에 따라 1~n번 조회한다 [실측].
- 과거로 스크롤: 브라우저가 `before` 커서로 다음 500봉을 요청한다. 캐시 구간 안이면 Postgres에서 바로, 밖이면 키움에서 받아 구간을 늘린다.
- 지표 알림이 잡은 키는 지표 계산에 필요한 만큼(`indicators::Spec::warmup()`의 4배와 500 중 큰 쪽) 서버가 미리 채운다.

### 6.7 종목 목록

- 하루 한 번(그날 처음 검색할 때, 또는 서버가 뜰 때 `symbols_fetched.fetched_on < 오늘`이면) ka10099로 코스피·코스닥을 받아 `cache.symbols`를 통째로 바꾼다. 코스피·코스닥 지수 두 개는 코드에 고정해서 넣는다.
- 우선주·리츠·ETF를 가리는 방법은 [실측](#1의 ka10099 항목). 기본값: 응답의 종목 구분 필드를 쓰고, 없으면 우선주는 종목명이 "우", "우B" 등으로 끝나는 것으로 판단한다.
- 검색은 메모리에서 한다. 정렬: 코드 완전 일치 > 코드 접두 > 이름 접두 > 이름 포함. 대소문자와 공백은 무시한다.

---

## 7. 사용자 자료 스키마

`app` 스키마에 둔다. sqlx 마이그레이션(`migrations/`)으로 관리한다. 사용자는 한 명뿐이라 사용자 id 열이 없다(ADR 0001).

- id는 브라우저가 만드는 UUID(v7)다. 그래서 생성과 수정이 모두 `PUT /…/:id`(upsert)이고, 자동 저장을 몇 번 다시 보내도 결과가 같다.
- JSON 열(`chart_settings`, `style`)은 서버가 받을 때 크기(64KB)만 검사하고 그대로 저장한다. 모양은 프런트엔드가 정한다. 서버가 해석해야 하는 것(드로잉 점, 알림 조건)은 별도 열로 두고 파싱해서 검사한다.

```sql
CREATE SCHEMA app;

-- 관심종목: 목록 하나
CREATE TABLE app.watchlist (
  symbol   text    PRIMARY KEY,
  position integer NOT NULL UNIQUE
);

-- 레이아웃
CREATE TABLE app.layouts (
  id          uuid        PRIMARY KEY,
  name        text        NOT NULL UNIQUE,
  arrangement text        NOT NULL CHECK (arrangement IN ('1','2h','2v','3','4')),
  sync        jsonb       NOT NULL,        -- { crosshair: bool } 등. 칸별 종목 연동은 칸에
  position    integer     NOT NULL,
  updated_at  timestamptz NOT NULL
);

CREATE TABLE app.layout_panes (
  layout_id      uuid     NOT NULL REFERENCES app.layouts(id) ON DELETE CASCADE,
  slot           smallint NOT NULL CHECK (slot BETWEEN 0 AND 3),
  symbol         text     NOT NULL,
  period         text     NOT NULL,
  symbol_link    boolean  NOT NULL,       -- 종목 연동
  chart_settings jsonb    NOT NULL,       -- 지표·기간·축·비교 종목. 프런트엔드 소유
  PRIMARY KEY (layout_id, slot)
);
-- slot 개수와 arrangement가 맞는지는 서버가 쓰기 전에 검사한다('1'→1칸, '2h'/'2v'→2칸, '3'→3칸, '4'→4칸).

-- 마지막으로 연 레이아웃, 테마 같은 화면 상태
CREATE TABLE app.ui_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  state     jsonb   NOT NULL
);

-- 드로잉: 종목에 붙는다. 봉 주기와 레이아웃에는 붙지 않는다.
CREATE TABLE app.drawings (
  id         uuid        PRIMARY KEY,
  symbol     text        NOT NULL,
  tool       text        NOT NULL CHECK (tool IN ('trendline','hline','vline','rect','fib','text')),
  points     jsonb       NOT NULL,        -- [{ t: Unix 초, price: number }]
  text       text,
  style      jsonb       NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE INDEX ON app.drawings (symbol);

-- 알림
CREATE TABLE app.alerts (
  id          uuid        PRIMARY KEY,
  symbol      text        NOT NULL,
  condition   jsonb       NOT NULL,       -- AlertCondition(§8.2). 서버가 파싱한다
  repeat      text        NOT NULL CHECK (repeat IN ('once','every')),
  enabled     boolean     NOT NULL,
  channels    text[]      NOT NULL,       -- 'telegram', 'in_app'
  note        text,
  updated_at  timestamptz NOT NULL
);

CREATE TABLE app.alert_events (
  id        bigserial   PRIMARY KEY,
  alert_id  uuid        NOT NULL REFERENCES app.alerts(id) ON DELETE CASCADE,
  fired_at  timestamptz NOT NULL,
  message   text        NOT NULL,
  delivered jsonb       NOT NULL          -- 채널별 성공/실패
);
```

- 첫 마이그레이션이 "기본" 레이아웃 하나(1칸, 코스피 지수 일봉)를 넣는다. 2단계(#3)에서 차트 설정 자동 저장은 이 레이아웃의 칸을 고치는 것이다. 레이아웃이 0개인 상태는 없다(마지막 레이아웃은 지울 수 없다).
- 드로잉 점 개수는 도구마다 고정이다: 추세선 2, 수평선 1, 수직선 1, 사각형 2, 피보나치 되돌림 2, 텍스트 1. 서버가 검사한다.
- 드로잉 점의 가격은 0.01 단위 정수가 아니라 실수다. 드로잉은 봉 가격이 아닌 아무 가격에나 놓을 수 있다.

알림의 Rust 타입:

```rust
pub enum AlertCondition {
    Price { op: PriceOp, target: Price },
    Indicator { period: Period, rule: IndicatorRule },
}
pub enum PriceOp { AtOrAbove, AtOrBelow }

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

`domain::alert`의 판단 함수(순수):

```rust
/// 가격 알림. 체결마다 부른다. 조건이 거짓→참으로 바뀌는 순간에만 true.
/// 처음 상태는 거짓이다. 그래서 만들 때 이미 조건을 넘어 있으면 다음 체결에서 울린다.
pub struct PriceArm { satisfied: bool }
pub fn judge_price(arm: &mut PriceArm, op: PriceOp, target: Price, trade: &Trade) -> bool;

/// 지표 알림. 봉이 확정될 때만 부른다. 직전 확정 봉과 이번 확정 봉의 값을 받는다.
/// Up: prev_a ≤ prev_b 이고 cur_a > cur_b. 값 중 하나라도 NaN이면 false.
pub fn judge_cross(dir: CrossDir, prev: (f64, f64), cur: (f64, f64)) -> bool;
```

- `Once`: 한 번 울리면 `enabled = false`로 저장한다.
- `Every`: 가격 알림은 조건이 다시 거짓이 되었다가 참이 될 때 또 울린다(`PriceArm`). 지표 알림은 교차가 다시 일어날 때 울린다.
- 켜진 알림의 종목은 `Holder::Alert`로 실시간 구독을 잡는다. 지표 알림은 그 `(종목, 봉 주기)` 집계기도 연다.
- **알려진 한계**: 끊긴 구간 동안의 체결은 조회로 되살릴 수 없다(조회로 받는 것은 봉뿐이다). 그래서 그 사이 가격이 조건에 닿았다 돌아왔으면 가격 알림은 울리지 않는다. 지표 알림은 끊긴 구간을 메운 뒤의 확정 봉으로 판단하므로, 메우는 동안 확정된 봉의 판단은 메우기가 끝난 뒤에 한다.

---

## 8. 브라우저 계약

프런트엔드는 이 절만 보고 데이터 계층을 짤 수 있다. 위의 내부 설계는 몰라도 된다.

### 8.1 공통 규칙

- 서버 주소: 같은 출처. REST는 `/api/…`, WebSocket은 `/api/ws`. 로그인은 없다.
- 시각 `t`는 **Unix 초(UTC 기준 정수)** 다. 봉의 `t`는 봉 시작 시각이다. KST로 보여 주는 것은 브라우저 일이다(Lightweight Charts는 UTC로 표시하므로 표시용으로 `t + 32400`을 넘기는 방법이 흔하다. 저장·전송하는 값은 언제나 원래 `t`다).
- 봉 시작 시각 규칙(§3.2): 분봉은 정시 기준 n분 경계, 일봉은 그 날짜 00:00 KST, 주봉은 그 주 월요일 00:00 KST, 월봉은 1일 00:00 KST.
- 가격은 자연 단위의 `number`다(주식 원, 지수 포인트). 주식은 정수, 지수는 소수 둘째 자리까지.
- 거래량은 `number`(정수).
- 모든 봉 메시지는 `t` 기준 **upsert**로 합친다. 같은 `t`의 봉이 다시 오면 덮어쓴다. 그러면 REST 페이지와 WebSocket 메시지가 어떤 순서로 와도 결과가 같다.
- 오류 응답: HTTP 4xx/5xx와 본문 `ApiError`.

```ts
type UnixSeconds = number;
type SymbolCode = string; // 주식·ETF "005930", 지수 "IDX:001"(코스피) "IDX:101"(코스닥)
type Period = "1m" | "3m" | "5m" | "15m" | "30m" | "60m" | "D" | "W" | "M";
type Uuid = string;       // 브라우저가 만드는 UUID v7

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
      | "conflict" | "internal";
    message: string;          // 사람이 읽는 한국어 설명
  };
}
```

### 8.2 REST

#### 종목

```ts
// GET /api/symbols?q=삼성&limit=20     (limit 기본 20, 최대 50)
// q가 비면 빈 배열
type SymbolSearchResponse = SymbolInfo[];

// GET /api/symbols/:code
type SymbolInfoResponse = SymbolInfo;

interface SymbolInfo {
  code: SymbolCode;
  name: string;
  kind: "common" | "preferred" | "reit" | "etf" | "index";
  market: "kospi" | "kosdaq";
}
```

#### 봉

```ts
// GET /api/bars?symbol=005930&period=D&limit=500[&before=1730000000]
// before 없음: 최신 페이지. current 포함.
// before 있음: t < before 인 확정 봉 중 최신 limit개. current는 null.
// limit 기본 500, 최대 1000.
// 응답이 키움 조회를 기다리면 수 초 걸릴 수 있다.
interface BarsPage {
  symbol: SymbolCode;
  period: Period;
  bars: Bar[];                     // 확정 봉, t 오름차순
  current: Bar | null;             // 현재 봉 스냅숏(최신 페이지일 때만)
  nextBefore: UnixSeconds | null;  // 더 과거를 받을 커서. null이면 끝
}
```

과거로 스크롤할 때는 받은 `nextBefore`를 그대로 `before`에 넣는다.

#### 현재가

```ts
// GET /api/quotes?symbols=005930,000660,IDX:001
// 관심종목을 처음 그릴 때 쓴다. 이후 갱신은 WebSocket quote 메시지.
type QuotesResponse = Quote[];

interface Quote {
  symbol: SymbolCode;
  price: number;
  change: number;       // 전일 종가 대비, 부호 있음
  changeRate: number;   // %, 부호 있음 (예: -1.23)
  volume: number;       // 당일 누적
  t: UnixSeconds;       // 이 값의 시각
  source: "realtime" | "polled";
}
```

#### 관심종목

```ts
// GET /api/watchlist
type WatchlistResponse = { symbols: SymbolCode[] };   // 표시 순서대로

// PUT /api/watchlist         본문: { symbols: SymbolCode[] }
// 목록 전체를 바꾼다. 추가·삭제·순서 바꾸기 모두 이것 하나로 한다. 중복은 400.
// 응답: WatchlistResponse
```

#### 레이아웃

```ts
interface LayoutSummary { id: Uuid; name: string; arrangement: Arrangement; updatedAt: UnixSeconds }

interface Layout {
  id: Uuid;
  name: string;
  arrangement: Arrangement;
  sync: { crosshair: boolean };
  panes: Pane[];                  // 길이는 arrangement 칸 수와 같다. slot 0부터
  updatedAt: UnixSeconds;
}
type Arrangement = "1" | "2h" | "2v" | "3" | "4";   // 2h 좌우, 2v 상하

interface Pane {
  slot: 0 | 1 | 2 | 3;
  symbol: SymbolCode;
  period: Period;
  symbolLink: boolean;           // 종목 연동
  chartSettings: unknown;        // 프런트엔드가 모양을 정한다. 64KB 이하. 서버는 그대로 저장
}

// GET    /api/layouts               → LayoutSummary[] (표시 순서)
// GET    /api/layouts/:id           → Layout
// PUT    /api/layouts/:id           본문: Omit<Layout, "updatedAt">  → Layout   (없으면 만들고 있으면 바꾼다)
// DELETE /api/layouts/:id           → 204. 마지막 레이아웃이면 409 conflict
// "새 레이아웃으로 복제"는 브라우저가 새 id로 PUT 한다.

// GET /api/ui-state                 → UiState
// PUT /api/ui-state   본문: UiState → UiState
interface UiState { lastLayoutId: Uuid | null; theme: "dark" | "light"; [k: string]: unknown }
```

`chartSettings` 안에 지표를 넣을 때는 아래 `IndicatorSpec`을 쓰기를 권한다. 알림을 만들 때 같은 값을 그대로 넘길 수 있다.

#### 드로잉

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

점의 `t`는 아무 시각이나 될 수 있다. 봉 시작 시각과 맞을 필요가 없다. 봉 주기가 다른 차트에서 어느 봉 위에 그릴지는 브라우저가 정한다.

#### 알림

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
  warning: "realtime_limit" | null;   // 읽기 전용. 실시간 한도에 걸려 판단하지 못하는 중
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
  message: string;             // 예: "삼성전자 RSI(14) 70 상향 돌파 · 일봉 확정 71,500"
}

// GET    /api/alerts                    → Alert[]
// PUT    /api/alerts/:id   본문: Omit<Alert, "updatedAt" | "warning">  → Alert
// DELETE /api/alerts/:id                → 204
// GET    /api/alert-events?limit=50     → AlertEvent[] (최신 먼저)
```

#### 지표 설정 타입(지표 크레이트와 같은 정의)

```ts
type IndicatorSpec =
  | { kind: "ma"; method: "sma" | "ema"; period: number }                      // 종가 기준
  | { kind: "bollinger"; period: number; k: number }
  | { kind: "ichimoku"; conversion: number; base: number; spanB: number; displacement: number }
  | { kind: "volume"; maPeriod: number | null }                               // 이동평균을 여럿 보려면 지표를 여러 개 띄운다
  | { kind: "rsi"; period: number; signal: number | null }
  | { kind: "macd"; fast: number; slow: number; signal: number }
  | { kind: "stochSlow"; k: number; d: number; smooth: number };

// 지표 종류별 출력 선 이름
type LineId =
  | "ma"                                                 // ma
  | "upper" | "middle" | "lower"                         // bollinger
  | "conversion" | "base" | "spanA" | "spanB" | "lagging" // ichimoku
  | "volume" | "ma"                                     // volume
  | "rsi" | "signal"                                     // rsi
  | "macd" | "signal" | "histogram"                      // macd
  | "k" | "d";                                           // stochSlow
```

이 TS 타입들은 서버가 Rust 타입에서 생성한다(`ts-rs`). 생성 파일은 `web/src/api/generated.ts`이고, CI가 생성 결과와 커밋된 파일이 같은지 검사한다. 이 문서의 표기와 생성 파일이 다르면 생성 파일이 맞다.

#### 변경 알림

같은 사용자가 탭을 여러 개 열 수 있다. 한 탭에서 사용자 자료를 바꾸면 서버가 모든 연결에 `data_changed`(§8.3)를 보낸다. 다른 탭은 그 자료를 다시 받는다. 쓰기 충돌은 나중에 쓴 쪽이 이긴다.

### 8.3 WebSocket `/api/ws`

텍스트 프레임 하나에 JSON 메시지 하나다.

#### 브라우저 → 서버

```ts
type ClientMessage =
  // (종목, 봉 주기) 구독. sub는 브라우저가 정하는 연결 안에서 유일한 문자열.
  // 칸의 주 종목과 비교 종목 각각이 구독 하나다.
  | { type: "subscribe"; sub: string; symbol: SymbolCode; period: Period }
  | { type: "unsubscribe"; sub: string };
```

- 같은 연결에서 같은 `(symbol, period)`를 여러 `sub`로 구독해도 된다. 메시지는 `sub`마다 따로 온다.
- 해지하거나 연결이 끊기면 서버는 그 종목을 30초 더 실시간 구독한 뒤 해지한다. 그래서 칸의 종목을 바꿨다가 바로 돌아오거나 새로고침해도 다시 등록하는 지연이 없다.

#### 서버 → 브라우저

```ts
type ServerMessage =
  | { type: "hello"; protocol: 1; serverTime: UnixSeconds; status: ConnectionStatus }
  | { type: "status"; status: ConnectionStatus }

  // 구독 응답. current는 지금의 현재 봉(없으면 null).
  | { type: "subscribed"; sub: string; current: Bar | null }
  | { type: "sub_error"; sub: string; code: "unknown_symbol" | "realtime_limit" | "kiwoom_unavailable" }

  // 현재 봉 갱신. 구독 하나당 초당 최대 10회. 중간 값은 건너뛸 수 있고, 마지막 값은 반드시 온다.
  | { type: "bar"; sub: string; bar: Bar }

  // 봉 확정. 빠짐없이, 순서대로 온다. 확정 순간의 최종 값이다.
  // 이 메시지 다음의 bar 메시지는 새 현재 봉이다.
  | { type: "confirmed"; sub: string; bar: Bar }

  // 이 구독의 확정 봉이 서버 쪽에서 바뀌었다. 다시 받아야 한다.
  //  gap_filled: 실시간 연결이 끊겼던 구간을 조회로 메웠다. from 이후의 봉을 다시 받는다.
  //  replaced:   실시간으로 만든 봉이 키움 값으로 교체되었다. from 이후를 다시 받는다.
  //  adjusted:   수정주가가 바뀌었다. 이 구독의 봉을 모두 버리고 처음부터 받는다(from 없음).
  | { type: "reload"; sub: string; reason: "gap_filled" | "replaced"; from: UnixSeconds }
  | { type: "reload"; sub: string; reason: "adjusted" }

  // 관심종목 현재가. 관심종목 전체에 대해 서버가 알아서 보낸다(구독 불필요).
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
- **확정 순간**: 봉이 확정되면 들고 있던 갱신을 버리고 `confirmed`를 바로 보낸다. `confirmed`는 건너뛰지 않는다. 브라우저가 느려서 연결의 보내기 버퍼가 차면, 서버는 `bar`와 `quotes`를 먼저 버린다. 그래도 `confirmed`를 넣을 자리가 없으면 연결을 닫는다. 브라우저는 다시 연결해서 다시 구독하고 최신 페이지를 다시 받는다.
- **장이 닫혀 있을 때**(20:00~08:00, 주말): 연결과 구독은 그대로 되고, `bar` 메시지가 오지 않는다.

#### 브라우저 쪽 권장 순서(차트 하나 열기)

1. `subscribe` 를 먼저 보낸다. 오는 `bar`/`confirmed`는 버퍼에 쌓는다.
2. `GET /api/bars` 최신 페이지를 받는다.
3. 페이지의 `bars`와 `current`, 그리고 버퍼의 메시지를 모두 `t` 기준 upsert로 합친다.
4. 과거로 스크롤하면 `nextBefore`로 다음 페이지를 받는다.
5. `reload`를 받으면 `from` 이후(`adjusted`면 전부)를 버리고 최신 페이지부터 다시 받는다. `from`이 첫 페이지보다 오래되었으면, 받은 가장 이른 `t`가 `from` 이하가 될 때까지 `nextBefore`로 이어 받는다. 구독은 유지한다.
6. WebSocket이 끊기면 다시 연결해서 1번부터 한다. 이미 받은 이전 확정 봉은 버리지 않아도 된다.

### 8.4 서버 쪽 구현 메모(브라우저가 몰라도 되는 것)

```rust
/// 연결 하나의 쓰기 태스크.
struct ConnWriter {
    /// confirmed, reload, subscribed 등 버리면 안 되는 메시지. 용량 256.
    must: mpsc::Receiver<ServerMessage>,
    /// 구독별 최신 현재 봉. 덮어쓰기만 한다.
    latest: HashMap<SubId, Bar>,
    dirty: BTreeSet<SubId>,
    // 100ms 타이머마다 dirty를 비우며 bar 메시지를 보낸다.
}
```

---

## 9. 지표 크레이트 API

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
#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Spec {
    Ma { method: MaMethod, period: u16 },
    Bollinger { period: u16, k: f64 },
    Ichimoku { conversion: u16, base: u16, span_b: u16, displacement: u16 },
    Volume { ma_period: Option<u16> },
    Rsi { period: u16, signal: Option<u16> },
    Macd { fast: u16, slow: u16, signal: u16 },
    StochSlow { k: u16, d: u16, smooth: u16 },
}

impl Spec {
    /// 설정값 검사(기간 1 이상, fast < slow 등). 브라우저와 서버 모두 쓴 직후 부른다.
    pub fn validate(&self) -> Result<(), SpecError>;
    /// 첫 유효 값이 나오기까지 필요한 봉 수.
    pub fn warmup(&self) -> usize;
    pub fn lines(&self) -> Vec<LineId>;
}

/// 선 하나의 값. values[i]는 입력 봉 i + shift 번째 위치의 값이다. 값이 없으면 NaN.
pub struct Line {
    pub id: LineId,
    pub shift: i32,        // 일목 선행스팬 +(displacement-1), 후행스팬 -(displacement-1), 나머지 0
    pub values: Vec<f64>,  // 길이 = 입력 봉 수
}

pub struct Output { pub lines: Vec<Line> }

/// 한 번에 전부 계산한다.
pub fn compute(spec: &Spec, bars: &Columns) -> Output;
```

- 출력 위치는 **봉 순서(index)** 다. 시각이 아니다. 시각으로 바꾸는 것은 호출자가 `t[i + shift]`로 한다.
- `i + shift`가 입력 범위를 넘으면(선행스팬의 마지막 25개) 미래 봉 시작 시각이 필요하다. 이것은 `future_bar_starts`가 만든다(§9.3).

### 9.2 현재 봉 하나만 바뀌었을 때

현재 봉은 체결마다 바뀌고, 확정 봉은 바뀌지 않는다. 그래서 상태를 "확정 봉까지"로 들고 있다가, 현재 봉은 그 상태의 복사본에 한 봉을 더해 미리 본다.

```rust
pub struct Engine {
    spec: Spec,
    state: State,      // 확정 봉까지 계산한 상태. 지표 종류마다 다르다(EMA 직전 값, 창 버퍼 등)
    output: Output,    // 확정 봉까지의 출력
}

pub struct BarInput { pub t: i64, pub open: f64, pub high: f64, pub low: f64, pub close: f64, pub volume: f64 }

/// 현재 봉이 들어간 마지막 위치의 값. 선마다 하나.
pub struct Tail { pub values: Vec<(LineId, f64)> }

impl Engine {
    /// 확정 봉 전체로 만든다. compute와 같은 결과를 output에 담는다.
    pub fn new(spec: Spec, confirmed: &Columns) -> Self;
    /// 확정 봉 하나를 더한다. O(창 크기) 이하.
    pub fn push_confirmed(&mut self, bar: &BarInput);
    /// 현재 봉을 넣었을 때의 마지막 값. 상태를 바꾸지 않는다.
    pub fn preview(&self, current: &BarInput) -> Tail;
    pub fn output(&self) -> &Output;
}
```

- 과거로 스크롤해서 앞쪽 봉이 늘면 `Engine::new`로 다시 만든다. 앞쪽이 바뀌면 EMA 계열 값이 모두 바뀌므로 덧붙일 수 없다.
- **불변식(테스트로 고정)**: 어떤 봉 목록이든 `Engine::new(앞 n-1개)` 뒤 `push_confirmed(n번째)`의 출력은 `compute(n개)`와 같다. `preview(x)`의 마지막 값은 `compute(확정 봉 + x)`의 마지막 값과 같다.
- 일목 선행스팬은 현재 봉이 바뀌면 `shift` 뒤의 미래 위치 값이 바뀐다. `Tail`에는 그 위치의 값이 들어간다.

### 9.3 미래 봉 시각(일목 선행스팬)

```rust
// domain::Period
/// last 다음부터 n개의 봉 시작 시각. 주말과 08:00~20:00 밖은 건너뛴다.
/// 공휴일은 모르므로 건너뛰지 않는다(알려진 한계). 이 함수는 indicators 의 wasm feature로 브라우저에도 나간다.
pub fn future_bar_starts(self, last: Bucket, n: usize) -> Vec<KstTime>;
```

- 브라우저는 이 시각들로 Lightweight Charts의 빈 자리(whitespace) 데이터를 만들어 선행스팬을 그린다.
- 공휴일 때문에 미래 시각이 하루 어긋날 수 있다. 그 봉이 실제로 생기면 그때 실제 시각으로 다시 그려진다.
- 분봉에서는 체결 없는 분도 시각으로 세므로, 거래가 뜸한 종목은 미래 위치가 실제와 다를 수 있다.

### 9.4 WASM 바인딩

`indicators`에 `wasm` feature를 둔다. 켜면 `wasm-bindgen`으로 다음을 내보낸다. 서버 빌드에는 `wasm-bindgen`이 들어가지 않는다.

```rust
#[wasm_bindgen]
pub struct WasmEngine(Engine);

#[wasm_bindgen]
impl WasmEngine {
    #[wasm_bindgen(constructor)]
    pub fn new(spec_json: &str, t: &[f64], o: &[f64], h: &[f64], l: &[f64], c: &[f64], v: &[f64])
        -> Result<WasmEngine, JsError>;
    pub fn push_confirmed(&mut self, t: f64, o: f64, h: f64, l: f64, c: f64, v: f64);
    /// [line0, line1, …] 순서의 Float64Array. 선 순서는 lines()와 같다.
    pub fn preview(&self, t: f64, o: f64, h: f64, l: f64, c: f64, v: f64) -> Vec<f64>;
    /// 선 하나 전체. shift는 shift(line)으로 따로 받는다.
    pub fn line(&self, index: usize) -> Vec<f64>;
    pub fn shift(&self, index: usize) -> i32;
    pub fn lines(&self) -> Vec<String>;
}

#[wasm_bindgen]
pub fn future_bar_starts(period: &str, last_start: f64, n: usize) -> Result<Vec<f64>, JsError>;
```

계산은 React 렌더링 밖(Web Worker 권장)에서 한다(#5). 이것은 프런트엔드 설계의 몫이다.

### 9.5 지표 종류 일곱 가지

| 지표 종류 | `Spec` | 기본 설정값 | 출력 선 | 계산 메모 |
|---|---|---|---|---|
| 이동평균 | `Ma { method, period }` | sma 20 | `ma` | 종가. EMA는 첫 `period`개의 단순평균에서 시작, α = 2/(n+1) |
| 볼린저 밴드 | `Bollinger { period, k }` | 20, 2.0 | `upper` `middle` `lower` | 표준편차는 모표준편차(n으로 나눔) |
| 일목균형표 | `Ichimoku { … }` | 9, 26, 52, 26 | `conversion` `base` `spanA` `spanB` `lagging` | 선행스팬은 shift +(displacement−1), 후행스팬 −(displacement−1) |
| 거래량 | `Volume { ma_period }` | 20 | `volume`, `ma` | 이동평균 여러 개는 지표를 여러 개 띄워서 본다 |
| RSI | `Rsi { period, signal }` | 14, null | `rsi`, `signal` | Wilder 평활. signal은 RSI의 단순평균 |
| MACD | `Macd { fast, slow, signal }` | 12, 26, 9 | `macd` `signal` `histogram` | EMA |
| 스토캐스틱 슬로우 | `StochSlow { k, d, smooth }` | 5, 3, 3 | `k` `d` | 국내 HTS 기본값을 따름 |

선행스팬 이동량(25냐 26이냐), 스토캐스틱 기본값, 볼린저 표준편차 정의는 참조값을 무엇으로 삼느냐에 따라 달라진다. 열린 질문(§13)에 남긴다.

EMA 계열(EMA, MACD, RSI)은 입력이 시작하는 봉에 따라 값이 조금 다르다. 브라우저가 과거로 스크롤해 입력이 길어지면 값이 미세하게 바뀐다. 서버의 지표 알림은 §6.6에 따라 충분히 긴 입력으로 계산하므로, 화면 값과 알림 판단 값이 아주 조금 다를 수 있다. 같은 코드라도 입력 길이가 다르면 결과가 다를 수 있다는 점은 ADR 0002의 "어긋나지 않는다"에 대한 단서다(§14).

---

## 10. 테스트

| 대상 | 방법 | 위치 |
|---|---|---|
| 봉 경계·확정 시각 | 표 기반 테스트. 봉 주기마다 08:00:00, 08:59:59, 09:00:00, 15:30:00, 20:00:00, 금요일 20:00, 월말 마지막 평일, 월초 | `domain` |
| 체결 날짜 정하기 | 수신 시각과 체결시간 쌍을 손으로 쓴다. 창 밖, 미래, 너무 과거 | `domain` |
| 현재 봉 집계 | 손으로 쓴 체결 목록 → `aggregate` → 확정 봉 목록과 현재 봉을 손으로 쓴 기대값과 비교. 시드와 `counted_through`, 늦은 체결, 체결 없는 분, 단일가 체결 한 건 | `domain` |
| 알림 판단 | 손으로 쓴 체결 목록으로 가격 알림(once/every, 만들 때 이미 넘은 경우), 손으로 쓴 지표 값 쌍으로 교차(같은 값, NaN) | `domain` |
| 구독 관리자 | `hold`/`release`/`plan`을 시각과 함께 부르는 시나리오. 30초 유예, 200 한도, 우선순위, 넘친 관심종목 → polled | `server::market` (순수 부분) |
| 지표 | 지표 종류마다 참조값 고정 파일(CSV)과 대조(허용 오차 1e-6). 그리고 위 §9.2 불변식을 proptest로: 무작위 봉 목록에서 증분 결과 = 전체 계산 결과 | `indicators` |
| 키움 파서 | `docs/kiwoom.md`의 응답 예시를 `server/tests/fixtures/kiwoom/*.json`로 그대로 옮겨 고정 입력으로 쓴다. 파일 머리에 출처(문서 절)를 적는다. 부호 붙은 가격, 지수 소수, 0B 부호 있는 체결량 | `server::kiwoom::wire` |
| 허용 목록 | 소스 전체에서 주문·계좌 경로와 api-id 문자열을 찾는 구조 검사(§4.4) | `server` |
| 대기열 | 가짜 시계와 가짜 전송으로: 초당 5회, `Screen` 먼저, 같은 요청 한 번, 요청 개수 초과 뒤 1초 멈춤 | `server::kiwoom::rest` |
| 캐시 구간 | `sqlx::test`(실제 Postgres)로: 과거로 늘리기, 앞으로 늘리기, 실시간으로 만든 봉 붙이기 조건, 출처 교체, 수정주가 대조 뒤 전체 삭제, 스키마 버전 불일치 시 재생성. 키움은 가짜 `MarketRequest` 응답으로 바꾼다 | `server::bars` |
| 브라우저 계약 | `ts-rs` 생성 파일이 커밋된 것과 같은지 CI 검사. 서버 → 브라우저 메시지 JSON 스냅숏 테스트 | `server::http` |
| 비밀값 | `Config`, `TokenHolder`, 텔레그램 클라이언트의 `Debug` 출력에 비밀값이 없는지 | `server::config` |

- 녹화 기능이나 재생 원천은 두지 않는다(ADR 0003). 실시간 경로 전체는 평일 08:00~20:00에 실제 키움으로만 돌려 본다. 그래서 그 경로의 판단 로직을 모두 순수 함수(`domain`)와 `SubscriptionManager::plan`으로 몰았다.
- 키움 파서 고정 입력은 `docs/kiwoom.md`가 나와야 만들 수 있다. 그 전에는 공개 문서의 예시로 임시 고정 입력을 만들고, 실측 결과가 나오면 교체한다.
- 지표 참조값의 원천은 열린 질문이다(§13).

---

## 11. 설정

### 11.1 `.env` 키

저장소 루트 `.env`. 값은 이 문서에 적지 않는다.

| 키 | 필수 | 뜻 |
|---|---|---|
| `VALLY_KIWOOM_APP_KEY` | 예 | 실계좌 앱키(ADR 0004) |
| `VALLY_KIWOOM_APP_SECRET` | 예 | 실계좌 시크릿(ADR 0004) |
| `VALLY_DATABASE_URL` | 예 | Postgres 접속 문자열 |
| `VALLY_BIND` | 아니오 | 받는 주소. 기본 `127.0.0.1:8080` |
| `VALLY_TELEGRAM_BOT_TOKEN` | 아니오 | 없으면 텔레그램 채널을 끈다(7단계 전에는 없어도 된다) |
| `VALLY_TELEGRAM_CHAT_ID` | 아니오 | 위와 함께 |
| `VALLY_STATIC_DIR` | 아니오 | SPA 빌드 결과 위치. 기본 `web/dist` |
| `VALLY_LOG` | 아니오 | `tracing` 필터. 기본 `info` |

`.env`에 이 밖의 `VALLY_` 키가 있으면 시작할 때 경고한다(오타 발견용). 모의 키 설정은 없다.

### 11.2 받는 주소

```rust
pub struct BindAddr(SocketAddr); // 루프백만. 생성자에서 검사

impl BindAddr {
    pub fn parse(s: &str) -> Result<Self, ConfigError>; // 127.0.0.0/8 또는 ::1 이 아니면 시작 실패
}
```

- 서버는 `127.0.0.1`에서만 받는다(ADR 0001). `0.0.0.0`이나 공인 주소를 주면 시작하지 않는다.
- 8단계(#9)에서 사설망 인터페이스 주소(예: Tailscale 100.64.0.0/10)를 허용 범위에 더한다. 그때도 공인 주소와 `0.0.0.0`은 받지 않는다.

### 11.3 로그에서 비밀값 가리기

```rust
/// Debug와 Display 모두 "[가림]"만 낸다. 값은 expose()로만 꺼낸다.
pub struct Secret<T>(T);
impl<T> Secret<T> { pub fn expose(&self) -> &T; }
```

- 앱키, 시크릿, 접근토큰, 텔레그램 봇 토큰, DB 비밀번호가 들어간 URL은 모두 `Secret`이다.
- 키움 요청을 로그에 남길 때는 api-id, 우선순위, 소요 시간, `return_code`만 남긴다. 헤더와 au10001 요청·응답 본문은 남기지 않는다.
- 텔레그램 봇 토큰은 URL 경로에 들어간다(`/bot<token>/sendMessage`). `reqwest` 오류는 URL을 품고 있으므로 로그에 남기기 전에 `without_url()`로 지운다.
- WebSocket LOGIN 메시지는 로그에 남기지 않는다.
- 파싱 실패 로그에 응답 원문을 남기는 것은 차트·종목 조회 응답만이다.

---

## 12. 실측 대기 항목

`docs/kiwoom.md`(#1)가 나오면 이 표를 채운다. 지금은 모두 기본값으로 설계했다.

| # | 항목 | 기본값(이 설계가 가정한 것) | 틀리면 바꿀 곳 |
|---|---|---|---|
| 1 | `_AL` 통합 시세 실시간(0B)이 KRX·NXT 체결을 한 흐름으로 주는가 | 준다 | 틀리면 "차트는 언제나 통합 시세"를 다시 연다(#1 완료 조건) |
| 2 | 차트 조회(ka10080/81/82/83)에 `_AL` 코드가 통하는가, 통합 봉을 주는가 | 통한다 | `kiwoom_stock_code` |
| 3 | 0B `9081` 거래소구분 값 | 쓰지 않는다(통합 흐름이면 필요 없음) | 파서 |
| 4 | 0B 필드: 20 체결시간 HHMMSS, 10 현재가(부호), 15 체결량(매수 +, 매도 −), 13 누적거래량, 11 전일대비, 12 등락율 | 이대로 | `parse_real_0b` |
| 5 | 0J 응답 형태, 지수 가격 소수 표기, 체결량 필드 | 가격은 소수 둘째 자리, 체결량은 누적거래량 차이로 구한다 | `parse_real_0j` |
| 6 | 09:00 시가·15:30 종가 단일가 체결이 0B로 어떻게 오는가 | 체결 한 건, 체결시간 09:00:00 / 15:30:00 | 봉 경계 표, 집계 테스트 |
| 7 | 키움 분봉 시각이 봉 시작인가 끝인가 | 시작 | `parse_chart_bars` |
| 8 | 키움 60분봉이 정시에 잘리는가 | 정시 | §3.2 표 |
| 9 | 키움 분봉이 체결 없는 분을 건너뛰는가 | 건너뛴다 | 캐시 구간 불변식 설명 |
| 10 | 키움 주봉·월봉의 날짜가 가리키는 날 | 아무 날이든 `bucket`으로 맞춘다 | 없음(정규화로 흡수) |
| 11 | 차트 조회 한 번에 오는 봉 수 | 분봉 900, 일봉 600 | 처음 열 때 조회 횟수 |
| 12 | 연속조회로 분봉을 과거 어디까지(1분, 60분) | 1분 약 1년 미만 | `reached_origin` 판단 |
| 13 | 분봉에 기준 시각 인자가 있는가, 연속조회 키 유효 시간 | 없다, 몇 분 | §6.3 과거로 늘리기 |
| 14 | 진행 중 구간의 봉이 차트 조회의 마지막에 오는가 | 온다 | 현재 봉 시드 |
| 15 | 지수 차트 api-id(ka20005/06/07/08)와 지수 코드(코스피 001, 코스닥 101) | 이대로 | `ApiId`, `IndexCode` |
| 16 | ka10099 `mrkt_tp=0`에 ETF가 섞이는가, 우선주·리츠 구분 | 섞인다, 구분 필드 있음 | §6.7 |
| 17 | 관심종목 여러 개 현재가 조회(ka10095)와 한 번에 넣을 수 있는 종목 수 | 있다, 100 | 넘친 관심종목 1분 조회 |
| 18 | 실시간 REG 한 메시지에 넣을 수 있는 종목 수, 전체 등록 한도 | 100, 200 이상 | §5.1, `REALTIME_LIMIT` |
| 19 | 오류 `return_code` 번호(요청 개수 초과, 토큰 무효, 인증 실패) | §4.3 표 | §4.3 |
| 20 | 초당 5회를 어떻게 세는가(고정 1초 창, 이동 창) | 이동 창으로 가정해 210ms 간격 | 대기열 간격 |
| 21 | 토큰 유효 기간, 유효 중에 다시 발급하면 같은 토큰을 주는가 | 약 24시간, 기존 토큰이 폐기될 수 있다(FAQ25) | §4.1 |
| 22 | WebSocket 주소와 LOGIN 응답 형태, PING 주기 | §5.1 | §5.1 |
| 23 | 0B 당일 시가·고가·저가·누적거래량이 `_AL`에서 KRX+NXT 합계인가 | 모른다. 쓰지 않는다 | §5.4 일봉 현재 봉 |
| 24 | 일요일 05:00 단절이 정확히 언제 다시 붙는가 | 바로 붙는다. 안 되면 30초마다 재시도 | §5.2 |

---

## 13. 열린 질문

1. **토큰을 디스크에 둘까.** 지금은 서버를 다시 켤 때마다 새로 발급한다. 재시작이 잦은 개발 기간에는 발급이 되풀이된다. `0600` 권한 파일에 토큰과 만료 시각을 두면 줄일 수 있지만, 비밀값이 디스크에 남는다. 기본값: 메모리에만 둔다.
2. **지표 참조값의 원천.** 후보는 (a) 키움 HTS 화면에서 읽은 값, (b) 공개된 계산 예시표(Wilder RSI 원문 예시, StockCharts 예시 등), (c) 다른 라이브러리로 한 번 계산해 커밋한 값이다. (c)는 Python을 쓰지 않는다는 ADR 0002와 부딪힐 수 있다(빌드에 들어가지 않는 한 번의 생성이라 괜찮다고 볼 수도 있다). 기본값: (b)를 쓰고 (a)로 몇 점 확인한다.
3. **일목 선행스팬 이동량.** 기본 `displacement − 1`(26일선이면 25봉 앞, 오늘을 1로 세어 26번째). 키움 HTS와 같은지 확인해야 한다.
4. **스토캐스틱 슬로우 기본값.** 국내 HTS 관행(5, 3, 3)과 해외 관행(14, 3, 3) 중 기본값. 기본값: 5, 3, 3.
5. **가격 알림이 만들 때 이미 조건을 넘어 있으면.** 기본값: 다음 체결에서 울린다(조건 = "가격이 그 값 이상인 체결이 있었다"). 교차할 때만 울리게 할 수도 있다.
6. **지표 알림이 판단에 쓸 봉 수.** EMA 계열은 입력 길이에 따라 값이 조금 다르다. 기본값: `warmup × 4`와 500 중 큰 쪽.
7. **주봉·월봉 확정 시각.** 기본값은 금요일 20:00, 마지막 평일 20:00. 지표 알림(주봉 기준)이 이 시각에 울린다.
8. **브라우저 계약의 `t`.** Unix 초(UTC 기준)로 정했다. 프런트엔드가 KST 표시를 위해 `t + 32400`을 쓰는 방식이면, 드로잉 점 저장 때 되돌리는 것을 잊지 않아야 한다. 서버가 KST 벽시계 초를 그대로 보내는 방법도 있지만, 이 문서는 진짜 Unix 초를 택했다(드로잉·알림 시각을 한 기준으로 두기 위해).
9. **실시간 한도를 칸·알림만으로 넘기면.** 기본값: 새 구독을 거절하고 오류를 보인다. 오래된 칸 구독을 밀어내는 방법도 있다.

---

## 14. 용어·ADR 제안

GLOSSARY.md와 ADR은 고치지 않았다. 아래는 제안이다.

### 용어

- **봉 출처**(새 용어 제안): 봉이 "실시간으로 만든 봉"인지 "키움에서 조회한 봉"인지. ADR 0003은 "실시간으로 만든 봉"이라는 말만 쓴다. _Avoid_ 목록에 "실시간 봉"이 이미 있어 헷갈리기 쉽다. "실시간 봉"은 현재 봉의 _Avoid_ 이고, "실시간으로 만든 봉"은 확정 봉의 한 출처라는 것을 용어집에 적어 두면 좋겠다.
- **현재가**(새 용어 제안): 관심종목에 보이는 종목의 마지막 가격과 전일 대비. 현재 봉의 종가와 같은 값일 때가 많지만 개념이 다르다(봉 주기가 없다).
- **구독**(새 용어 제안): 서버가 한 종목의 실시간 체결을 키움에서 받고 있는 상태. 칸·관심종목·알림이 구독을 잡는다.
- **캐시 구간**(새 용어 제안): (종목, 봉 주기)마다 캐시가 빠짐없이 갖고 있는 시각 범위.
- **끊긴 구간**(새 용어 제안): 실시간 연결이 끊겨 체결을 받지 못한 시간. 다시 연결되면 조회로 메운다.

### ADR

- **ADR 0003 "실계좌 초당 5회, 모의 초당 1회"**, 이슈 #2의 같은 문구, 로드맵 #12의 "#1 0단계: 키움 REST API 실측(모의 키)": ADR 0004가 모의 키를 쓰지 않기로 했으므로 모의 쪽 언급은 남은 흔적이다. 정리를 제안한다.
- **ADR 0003 "단위: 다른 봉 주기에서 파생하지 않는다"** 와 이 설계의 "일·주·월 현재 봉을 체결로 만든다": 이 설계는 체결에서 직접 현재 봉을 만들 뿐 다른 봉 주기의 봉에서 파생하지 않으므로 부딪히지 않는다고 본다. 다만 ADR에 "현재 봉은 봉 주기마다 체결로 직접 만든다"를 한 줄 적어 두면 오해가 없다.
- **ADR 0002 "구현이 하나라서 두 곳의 계산 결과가 어긋나지 않는다"**: 같은 코드라도 입력 길이가 다르면 EMA 계열 값이 조금 다르다(§9.5). "같은 입력이면 같은 결과"로 표현을 좁히거나, 서버 알림 판단과 화면 계산의 입력 길이를 맞추는 규칙을 더하는 것을 제안한다.
- **ADR 0001 "로컬에서는 127.0.0.1"**: 이 설계는 이를 `BindAddr` 타입으로 강제한다. 클라우드(#9)용 허용 범위는 그 단계에서 정하는데, ADR에 "공인 주소에 묶으면 서버가 시작하지 않는다"를 결과로 적어 둘 만하다.
