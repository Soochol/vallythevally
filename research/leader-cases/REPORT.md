# 주도 사례 리포트 HTML

#142의 생성기는 #137 원고와 #141 `Bundle`로 정적 HTML 한 파일을 만든다. 자료·차트 라이브러리·스크립트·스타일을 내장하므로 로컬 파일로 열 수 있다. 원천 HTTP, 사용자 서버, 키 파일을 읽지 않는다. 외부 링크는 사람이 눌렀을 때만 열린다.

## 실행

Node 22.18 이상과 기존 웹 의존성을 사용한다. 새 의존성이나 잠금파일은 없다.

```sh
pnpm --dir web install --frozen-lockfile
node research/leader-cases/generate-report.ts --help
node research/leader-cases/generate-report.ts \
  --manuscript /path/to/manuscript.json \
  --bundle /path/to/bundle.json
```

출력은 스크립트가 있는 worktree의 `data/leader-cases/<code>/report.html`이다. 종목코드를 검증하고 원고와 묶음의 코드가 같을 때만 쓴다. 임시 파일을 같은 디렉터리에 쓴 뒤 이름을 바꾼다. 묶음 입력 손상·불일치는 종료 코드 1, 그 밖의 설정·원고·생성 오류는 종료 코드 2이며 기존 HTML을 덮어쓰지 않는다. 자료와 생성 HTML은 기존 `data/` 제외 규칙을 따른다.

#173부터 자료 입력은 버전 2 `BundleDocument`다. Node는 파일을 한 행씩 읽고 페이지별로 압축을 풀어 계약을 검증한다. HTML은 동일한 manifest와 독립 페이지들을 여러 비실행 JSON script 요소에 내장한다. 생성기와 브라우저 모두 전체 논리 Bundle을 JSON 문자열 하나로 합치지 않는다. Chromium의 `DecompressionStream("gzip")`는 `file://`와 이 CSP에서 검증했다. 외부 조회나 `fetch`는 필요 없다. 페이지 계약과 대표 크기 검증은 [SIZE.md](SIZE.md)에 있다.

자료 근거는 펼칠 때만 DOM으로 만든다. 페이지 복원 중 미리 펼친 근거도 준비 완료 후 한 번 표시한다. 객체는 필드별로, 큰 배열은 128행 묶음으로 펼친다. 공시일 축의 각 날짜를 펼치면 수치와 출처 링크가 나타나며 TTM 후보는 다시 펼쳐 볼 수 있다. 같은 접수번호가 필요한 여러 수치에서도 원래 근거를 표시한다. 압축 페이지는 표시용 DOM과 별개로 HTML 안에 모두 남는다.

입력 오류는 `manuscript_input`, `bundle_input`, 생성·출력 오류는 `html_generation`, `html_output`으로 구별한다. 원천 문자열이나 입력의 오류 내용을 표준 오류에 되풀이하지 않는다.

합성 예제는 기존 자료 수집기의 로컬 HTTP fixture를 통과한 `Bundle`이다. 실제 시세나 원고는 없다.

```sh
node research/leader-cases/fixtures/write-report-inputs.ts
node research/leader-cases/generate-report.ts \
  --manuscript target/leader-cases-142/fixture/manuscript.json \
  --bundle target/leader-cases-142/fixture/bundle.json
```

브라우저에서 `data/leader-cases/990001/report.html`을 연다. PNG는 이 합성 입력만 사용한다.

## 원고 계약

타입과 검증은 [manuscript.ts](manuscript.ts)의 `Manuscript`, `Sentence`, `parseManuscript`가 정의한다. `schemaVersion`은 1이고 `code`는 대문자·숫자 6자리다.

- `title`은 일반 문자열이다. HTML이나 Markdown으로 실행하지 않는다.
- `milestones.birth`, `peak`, `extinction`은 각각 `day`와 하나 이상의 `evidence` 문장을 갖는다. 날짜 순서는 탄생일 ≤ 정점 < 소멸일이다. 날짜를 자동으로 찾거나 가격 판정을 만들지 않는다.
- `sections`는 번호 0부터 12까지 순서대로 한 번씩 존재하며 각 절은 `sentences` 배열을 갖는다. 제목은 부모 spec의 고정 제목이다.
- `events`는 `publishedOn`, `title`, `url`, `kind`, `sentences`를 갖는다. 종류는 `industry`, `policy`, `technology`, `capital`, `index`다.
- 모든 문장은 `text`, `citations`와 시점 구분 `kind`를 갖는다. `then-visible`에는 `asOf`와 하나 이상의 인용이 필요하다. 인용의 `publishedOn`은 `asOf`보다 늦을 수 없다. `retrospective`에는 인용이 없어도 된다.
- 인용은 `publishedOn`, `url`, `quote`를 갖는다. 수치·자료 이름을 `quote`에 적는다. 검증기는 인용 내용의 사실 여부를 판정하지 않는다.

`fixtures/report.ts`의 `syntheticManuscript()`가 전체 합성 예제다. 모든 날짜는 존재하는 `YYYY-MM-DD`이고 링크는 자격증명 없는 절대 HTTP 또는 HTTPS 주소여야 한다. 원고·링크·자료 JSON을 HTML에 넣을 때 각각 텍스트와 속성 escape, script 종료 방지 JSON escape를 적용한다. 콘텐츠 보안 정책은 내장 코드와 스타일만 허용하고 네트워크 조회를 막는다.

묶음은 [report-input.ts](report-input.ts)가 `bundle-types.ts`의 버전 2 전체 구조를 검증한다. 원고 `Manuscript`는 버전 1 그대로다. 유한 숫자, null 이유, 날짜 순서·중복과 원문 링크를 검사한다. 현재 웹 생성 타입과 다른 종목 종류를 임의로 허용하지 않는다. `input-schema.ts`의 객체 파서는 필드를 모두 검증한 뒤에만 타입을 부여한다.

## HTML과 차트 계약

`report-model.ts`는 패널 목록과 시계열을 만든다. `report-page.ts`는 절 0~12와 근거를 출력하고 `report-browser.ts`는 실제 lightweight-charts를 실행한다. 제품 서버와 `web/src`는 변경하지 않는다. 글꼴·색·높이는 읽고 시험하기 위한 임시 값이며 디자인 결정이 아니다.

모든 날짜 차트는 일봉·주봉·공시일·사건·생애 기준일의 날짜 합집합을 사용한다. 초기 범위는 상장 이후 자료의 첫 날짜부터 묶음 요청 종료일까지다. 주봉은 그 주의 실제 마지막 관측일에 그린다. 관측 간격과 null은 구분하며, 빠진 일·주와 명시적 null에서는 선을 끊는다. 주별 값을 일별 숫자로 보간하지 않는다. 값이 없는 거래대금·시장 비중·시총순위는 이유와 빈 차트를 남긴다. 같은 패널의 정상 선은 계속 표시한다.

값이 전혀 없는 lightweight-charts 차트도 같은 날짜축을 유지하도록 `calendar-only` 숨김 시리즈에 날짜의 경과 일수를 넣는다. 이 값은 자료 시리즈나 가격축에 표시하지 않으며, 거래대금·재무 null에 넣는 대용값이 아니다. 십자선은 실제 차트의 마우스 이벤트와 날짜 좌표에서 받은 날짜를 모든 패널의 세로 커서와 값 표시로 보낸다. 그날 관측값이 없으면 자료 없음이라고 표시한다. 날짜 커서는 차트 밖으로 나가도 마지막 날짜를 유지하므로 새로 켠 패널에도 적용된다.

사용자가 움직인 차트만 공통 논리 범위를 갱신한다. 다른 차트의 프로그램 범위 변경을 재전파하지 않는다. 새 패널에는 현재 범위·날짜 커서·세 기준일 세로선을 적용한다. 장세 배경은 대상 시장 지수의 원래 날짜를 따르고, 사건은 공개일, 실적 공시는 실제 공시일에 표시한다.

2절은 별도 회계기간 축이다. 분기·연간 전환과 항목 선택, 전체 재무 항목 표, 공시일·사용 가능일·공시까지 걸린 날수를 제공한다. `quarters`/`annual` 원장과 `latestMetrics`/`latestAnnualMetrics`를 사용한다. 최신 다운로드로 정정된 요약이며 당시 알려진 수치를 뜻하지 않는다. 이 축은 날짜 차트의 공통 범위와 십자선 연동에서 제외하되 세 생애 기준일은 표시한다.

6절 재무의 점은 반드시 `FinancialData.timeline`에서 만든다. TTM 흐름 항목은 TTM이라고 표시한다. 주식수와 연간 DPS의 원장 값도 timeline 날짜에서 `availableFrom`과 출처 공개일을 통과한 경우에만 사용한다. DPS는 가장 최근에 공개된 연간 값을 유지한다. 공시일 다음 관측일부터 다음 변경점까지 알려진 값을 유지하고, null 변경점부터 선을 끊는다. 최신 요약을 과거 날짜에 재사용하지 않는다.

근거에는 숫자·null 이유·단위·사용 가능일과 출처의 공개일·접수번호·원문 링크·계정·선택 방법·원천 필드를 표시한다. 수치의 정확한 원본 접수번호가 최종 공시 목록에서 첨부정정본으로 대체됐어도 수치 출처의 공개일을 그대로 쓴다. 회계기간 표의 공시일·다음 관측일·공시까지 걸린 날수도 검증된 재무 API 접수번호를 따른다. 최종 공시 목록의 번호로 수치 출처를 바꾸지 않는다. TTM 근거의 `paths`는 후보 전체이며, `activePaths`는 `evaluatedOn`에 사용 가능했던 경로다. 미공개 후보는 점검용이라는 문구와 함께 별도로 펼쳐 보이며 차트에는 넣지 않는다. `ttm_path_conflict`는 해당 값과 종속 PER 밴드를 끊고 독립된 BPS 같은 값은 유지한다.

기관 선은 관측 구간별 누적 순매수 수량이다. 누락 후 새 `segmentStart`에서 재개하며 `knownNetSinceStart` 부분합을 연속 보유량처럼 그리지 않는다. 시작일·누락·불확실성은 날짜 표시와 7절 원장에서 확인한다. 12절에는 수집 실패, 수급 coverage, FRED 최신 빈티지와 원 날짜, 회사식별, 수정주가·생존 편향·재무 근거를 보존한다.

`window.leaderReport.inspect()`는 동작 검증용 읽기 함수다. 실제 차트의 보이는 범위·날짜 좌표·기준일 좌표·자료 시리즈를 반환한다. 차트를 대체하거나 시험용 값을 만드는 함수는 없다.

## 검증

```sh
npm --prefix research/leader-cases run typecheck
npm --prefix research/leader-cases run test:report
VALLY_E2E_BIN_DIR=target/leader-cases-142/bin npm --prefix research/leader-cases test
npm --prefix research/leader-cases run test:browser
```

전체 도구 시험 전에 server·fake-kiwoom 바이너리를 worktree의 지정 디렉터리에 준비한다. 기존 [README](README.md)의 바이너리 재사용 절차를 따른다. 새 HTML 브라우저 시험은 서버나 Rust 빌드 없이 실제 파일을 오프라인 브라우저로 열며, 실제 차트의 기본 패널·묶음·십자선·범위·세 기준일·늦게 켠 차트·분기/연간·정정 전후 TTM·escape·콘솔 오류를 확인한다. 결과와 trace는 이 worktree의 `target/leader-cases-142/test-results`에 둔다.

합성 데스크톱 증거는 `fixtures/synthetic-report-desktop.png`다. 스크린샷은 화면 검토 자료이며 시각 디자인의 승인본이 아니다. 실제 원고 #143은 이 작업에 포함하지 않는다.
