# 미검증 TR 실응답 픽스처 캡처 안내 (`collector probe-tr`)

`collector probe-tr`은 운영자가 장중 또는 확인 시점에 키움·한투 REST TR을 **단 1회** 호출해, 민감 정보(토큰·앱키·시크릿·계좌번호)를 제거한 JSON 픽스처를 저장하는 수동 CLI다. 자동 시험에서는 실행하지 않는다.

## 동작 원칙

- 기존 키 목록(`--keys`, 기본값 `VALLY_KEYS` 또는 `~/.config/vally/collector-keys.json`)에서 `--key`로 고른 활성 키를 읽는다.
- 해당 키의 토큰 파일에 유효한 토큰이 있으면 그대로 재사용해 불필요한 토큰 재발급을 피한다.
- 대상 경로(`--path`)에 HTTP 요청을 정확히 1회만 보내고, 응답 본문의 민감 키(`token`, `secret`, `appkey`, `app_key`, `cano`, `acnt`, `account`, `authorization`)와 사용된 앱키·시크릿·토큰 문자열을 `[REDACTED]`로 가린 뒤 `<out>/<broker>-<tr_id>.json`에 원자적으로 기록한다.
- 요청 헤더(`authorization`, `appkey`, `appsecret`)는 출력 파일에 저장하지 않는다.

## 실행 예

### 한투(KIS) TR (`GET` 기본값)

```sh
collector probe-tr \
  --broker kis \
  --tr CTCA0903R \
  --path /uapi/domestic-stock/v1/quotations/chk-holiday \
  --query "BASS_DT=20261125&CTX_AREA_NK=&CTX_AREA_FK=" \
  --key rest-kis \
  --out crates/server/tests/fixtures/kis
```

### 키움(Kiwoom) TR (`POST` 기본값, `--body` 기본 `{}`)

```sh
collector probe-tr \
  --broker kiwoom \
  --tr ka10063 \
  --path /api/dostk/mrkcond \
  --body '{"mrkt_tp":"001","amt_qty_tp":"1","invsr":"6","frgn_all":"0","smtm_netprps_tp":"0","stex_tp":"1"}' \
  --key rest-kw \
  --out crates/server/tests/fixtures/kiwoom
```

## 캡처 대상 미검증 TR 목록

### 한투(KIS)

| TR ID | 용도 | 비고 |
| :--- | :--- | :--- |
| `FHKST03030100` | 해외 지수·환율·금리 일별 시세 | 글로벌 매크로 |
| `FHMIF10000000` | 국내 선물 현재가·베이시스 | 파생 시세 |
| `FHPTJ04030000` | 선물·옵션 투자자별 매매동향 | `F001` / `OC01` / `OP01` 확인 |
| `FHPIF05030000` | 옵션 전광판(PCR) | 콜/풋 거래량·미결제약정 |
| `FHKST649100C0` | 증시 자금 동향 | 예탁금·신용잔고 등 |
| `FHPST04820000` | 공매도 상위 종목 | 리스크 감시 |
| `FHPST01390000` | VI 발동 현황 | 한투 보조 경로 |
| `CTCA0903R` | 국내 휴장일 조회 | 장 운영 캘린더 |

### 키움(Kiwoom)

| TR ID | 용도 |
| :--- | :--- |
| `ka10063` | 장중 투자자별 매매 상위(세부 기관) |
| `ka10066` | 장마감 후 투자자별 매매(세부 기관) |
| `ka90006` | 프로그램 차익/비차익 잔고 추이 |
| `ka90007` | 프로그램 매매 누적 추이 |
| `ka10010` | 업종별 프로그램 매매 |
| `ka10016` | 신고가/신저가 종목 |
| `ka10017` | 상한가/하한가 종목 |
| `ka10036` | 외국인 한도 소진율 상위 |
| `ka10037` | 외국계 창구 매매 상위 |
| `ka10068` | 대차거래 추이 |
| `ka90012` | 대차거래 내역 |
| `ka40004` | ETF 전체 시세 요약 |

## 커밋 전 확인

1. 생성된 JSON 파일에 앱키·시크릿·토큰·계좌번호 문자열이 남아 있지 않은지 `rg`로 확인한다.
2. 응답 구조(`output`, 배열 필드명, 부호, 단위)가 예상과 맞는지 확인한 뒤 `MKT-06`·`MKT-07` 파서 시험에 연결한다.
