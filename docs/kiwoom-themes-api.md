# 키움 테마 서버 경로

키움이 정한 테마(`ka90001` 테마그룹별요청, `ka90002` 테마구성종목요청)를 그대로 내주는 경로다. 히트맵의 그룹과 종목을 키움 분류로 구성하는 일([제안](https://claude.ai/artifact/Xeda2yLqGZ87j3QpBE4yM2))의 첫 단계다. 실제 응답 모양(테마 수, 연속조회 쪽수, 가이드에 없는 칸)을 실서버에서 확인하는 데도 쓴다. 화면은 이 경로를 쓰지 않는다. 히트맵의 키움 테마 탭은 아래 "구성종목 하루 저장"이 받아 둔 것을 보드(`/api/heatmap/board?source=kiwoom`)로 본다.

요청 칸과 코드값은 키움 공식 가이드([ka90001](https://openapi.kiwoom.com/m/guide/apiguide/01/ka90001), [ka90002](https://openapi.kiwoom.com/m/guide/apiguide/01/ka90002))를 따른다. 두 TR은 `/api/dostk/thme`이고 시세 허용 목록에 든다.

## `GET /api/kiwoom-themes?days=1&venue=combined`

| 인수 | 뜻 |
|---|---|
| `days` | 기간수익률의 기간, 1~99일. 기본 1. 키움 `date_tp` |
| `venue` | `combined`(기본), `krx`, `nxt`. 키움 `stex_tp` |

키움에는 전체검색(`qry_tp` 0), 상위등락률 정렬(`flu_pl_amt_tp` 3)로 묻는다. 연속조회를 끝까지 따라가되 20쪽(`MAX_PAGES`)에서 멈춘다. 같은 테마코드는 처음 것만 남긴다.

응답 `KiwoomThemeList`:

| 칸 | 뜻 |
|---|---|
| `themes[]` | `code`(테마그룹코드), `name`, `stockCount`, `changeRate`(%), `periodReturn`(`days`일 기간수익률, %), `rising`, `falling`, `leaders`(키움 주요 종목 이름, 쉼표로 나눔) |
| `pages` | 받은 쪽 수 |
| `complete` | 마지막 쪽까지 받았다. 20쪽에 닿아 멈췄으면 거짓 |
| `skipped` | 읽지 못해 뺀 행 수 |
| `fetchedAt` | 받은 Unix 초 |

## `GET /api/kiwoom-themes/{code}?days=1&venue=combined`

`code`는 영문·숫자 1~6자다. 응답 `KiwoomThemeMembers`는 테마 등락률·기간수익률(`changeRate`, `periodReturn`, 응답에 없으면 `null`)과 `members[]`다. 구성종목은 `symbol`, `name`, `price`(원), `changeRate`(%), `volume`(누적거래량, 주), `periodReturn`(없으면 `null`), `limit`(`upper` 상한가, `lower` 하한가, 아니면 `null`)이다. 키움 구성종목 응답에는 거래대금 칸이 없다(가이드 기준).

## 호출과 캐시

- 우선순위는 화면(`Priority::Screen`)이다. 키움 대기열이 TR마다 1초에 5건으로 센다(ADR 0035).
- 결과는 (테마코드, 기간, 거래소)마다 서버 메모리에 45초(`FRESH_SECS`) 둔다. 날이 바뀌면 버린다.
- 한 번 받을 때마다 서버 로그에 `키움 테마 응답을 받았습니다` 한 줄을 남긴다. api-id, 쪽 수, 행 수, 뺀 행 수, 끝까지 받았는지, 가이드에 없던 응답 칸 이름(`unknown_fields`)이다. 값은 남기지 않는다. 실측은 이 줄을 `journalctl --user -u vally-server.service`에서 읽는다.

## 구성종목 하루 저장

`kiwoom_themes::start_collection`이 매일 08:30(KST) 이후 첫 기회에 `ka90001`(1일, 통합)로 테마 목록을, 테마마다 `ka90002`로 구성종목 코드를 받아 `<사용자 DB 폴더>/kiwoom-themes/YYYYMMDD.json`에 둔다(`VALLY_KIWOOM_THEMES_DIR`로 바꾼다). 배경 우선순위다. 목록을 받지 못하면(키움이 연결되지 않은 때 포함) 5분 뒤 다시 받는다. 오늘 파일이 있으면 받지 않는다. 서버가 켜질 때 가장 최근 파일을 읽는다. 결정은 [ADR 0042](adr/0042-heatmap-adds-kiwoom-themes-as-a-second-source.md)이다.

```json
{ "date": "20261123", "collected_at": 1795000000, "themes": [ { "code": "319", "name": "조선", "members": ["042660", "010140"] } ] }
```

## 시험

- `python3 scripts/dev.py cargo test -p server --lib theme`: 요청 본문, 응답 읽기(부호·쉼표·거래소 접미사·상하한가·빈 기간수익률·모르는 칸).
- `python3 scripts/dev.py cargo test -p server --test kiwoom_themes`: 합성 transport로 쪽 걷기와 중복 제거, 캐시, 구성종목, 되풀이된 연속조회 키, 잘못된 인수, 하루 수집과 실패 때 지난 구성종목 쓰기.
- `python3 scripts/dev.py cargo test -p server --lib kiwoom_themes::catalog`: 저장 파일 열기·쓰기, 수집할 때 판정.
