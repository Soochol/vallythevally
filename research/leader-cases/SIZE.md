# 전체 자료 묶음 크기와 페이지 계약

#173은 수집을 마친 전체 자료 묶음이 저장되지 않던 문제를 고친다. 기존 `JSON.stringify(bundle, null, 2)`는 가격 준비 이력과 매일 반복되는 재무 근거를 한 문자열로 확장했다. 실제 #143 진단은 1,931요청 뒤 `buildBundle`이 반환했고 이 직렬화에서 `RangeError: Invalid string length`가 났다. 저장된 실제 Bundle은 없으므로 아래 숫자는 실제 자료의 크기를 주장하지 않는다.

## 크기 재현

실제 키·원자료·네트워크를 쓰지 않는 `fixtures/scale.ts`가 `buildBundle`의 실제 producer·가격 집계·재무·TTM·밴드 계산을 통과한다. 30섹터×6종목과 지수 2개, 1990-01-02~2026-11-10 평일 가격 이력, 2015~2026년 48분기와 2016~2026년 2,833일의 요청 범위를 사용한다. 가격 1,750,112행, 공시일 축 46점이다. 실제 로그의 가격 페이지는 1,794회였다. 합성 입력은 준비 이력을 모든 종목에 동일하게 주어 전체 가격 페이지 수와 비슷한 부피를 만든다. 실제 종목의 상장일 분포를 재현한 자료는 아니다.

```sh
npm --prefix research/leader-cases run diagnose:size
npm --prefix research/leader-cases run verify:size
npm --prefix research/leader-cases run test:browser
```

`diagnose:size`는 단일 JSON 문자열을 만들지 않고 UTF-8 바이트·V8 문자열 문자 수·확장 객체·배열·숫자 수를 계수한다. 작은 Unicode·반복 참조 입력에서 실제 `JSON.stringify`와 일치하는 대조 시험을 실행한다. 원자료 가격, 재무 원장·최신 요약·공시일 축, EPS·BPS·PER·PBR와 일별 밴드의 크기를 구분한다. 결과는 `target/leader-cases-173/scale/sizes.json`이다.

`verify:size`는 producer 저장, 정상 읽기, 실제 HTML CLI를 각각 힙 1,536MiB로 제한한 독립 Node 자식에서 순서대로 실행한다. 이전 방식의 pretty JSON이 실제 런타임 문자열 한도를 넘는지 계수로 먼저 단언한다. 위험한 8억 문자 문자열 자체를 만들지 않는다. 복원 뒤에는 키 순서만 정규화한 전체 필드 지문을 비교해 숫자·null 이유·원본 접수번호·미공개 후보·중복 출처·TTM 양쪽 경로를 모두 검사한다. 원천을 삭제하거나 정상 빈 자료로 바꾸면 이 비교가 실패한다. 단계별 최대 RSS·페이지 수·파일 크기·지문은 `measurement.json`과 `verification.json`에 남는다.

브라우저 시험은 같은 producer부터 다시 실행한 후 생성된 `data/leader-cases/980173/report.html`을 실제 오프라인 Chromium에서 연다. `DecompressionStream`, CSP, 차트 시리즈, 정정 전 200과 정정 후 충돌 null, 독립 BPS 70, PER 밴드 단절, 연간 전환, 여러 수치의 같은 정정 접수번호와 양쪽 TTM 금액을 확인한다. 페이지 오류는 ready 상태를 만들지 않는다. HTTP 요청과 콘솔 오류는 0이어야 한다. JS 힙과 Linux renderer RSS는 `browser.json`, 화면은 `synthetic-scale-charts.png`, `synthetic-scale-ttm.png`, `synthetic-scale-evidence.png`에 남는다.

2026-11-11의 #172 통합 합성 입력은 1,950회 in-process 응답을 처리했다. 확장 객체 3,608,225개·배열 681,026개·숫자 13,941,970개를 보존했다. 같은 입력의 바이트 계수는 반복 실행에서 같았다. 들여쓴 전체 문자열은 832,165,836문자로 런타임 한도 536,870,888을 넘는다.

| 필드 | compact UTF-8 바이트 | 기존 들여쓰기 UTF-8 바이트 |
| --- | ---: | ---: |
| 전체 | 391,710,949 | 837,389,842 |
| 가격 원자료·주봉 | 203,133,827 | 475,850,820 |
| 섹터 이력 | 90,878,721 | 199,648,974 |
| 일별 밸류에이션·8개 밴드·반복 근거 | 85,595,995 | 140,062,016 |
| DART 원장·최신 요약·공시일 축·TTM 후보 | 4,592,103 | 8,432,917 |

따라서 재무 출처만 줄이면 가격·섹터와 HTML 원장의 큰 전개가 남는다. 선택한 페이지 표현은 모든 필드를 그대로 보존한다. 동일 입력의 저장 파일은 301페이지·56,964,393바이트이며 가장 큰 복원 페이지는 4,592,138바이트, 가장 긴 압축 페이지 JSON은 272,390문자다. HTML도 같은 페이지들을 내장하며 전체 크기는 약 57.2MB다. 정확한 HTML 크기와 메모리 값은 생성한 코드·런타임과 함께 위 검증 파일에 기록한다.

최종 검증에서 HTML은 57,212,416바이트였다. 계수·지문 비교까지 포함한 producer 자식의 최대 RSS는 1,526,372KiB, 읽기는 1,052,296KiB, HTML CLI는 1,272,588KiB였다. 각 자식의 힙 상한은 1,536MiB이며 production 도구의 힙을 늘리는 변경은 없다. Chromium은 301페이지와 실제 차트를 복원했고 관측 시점 JS 사용 힙 547,725,100바이트·renderer RSS 1,229,128KiB였다. RSS 최대값과 브라우저 관측 시점 값은 서로 다른 측정값이며 실행마다 달라질 수 있다. 속도 개선 수치로 사용하지 않는다.

## 버전 2 문서

논리 `Bundle`은 `bundle-types.ts`의 버전 2 자료다. 금융 필드·`Measure.sources`·`FactSource`·TTM 경로는 기존 구조를 유지한다. `BundleDocument`는 저장·HTML 전달 타입으로 `{manifest, pages}`다. 디스크의 `bundle.json`은 다음 순서를 가진 유효한 JSON 배열이다. 여는 대괄호와 닫는 대괄호는 각각 독립 행이고 manifest와 각 페이지는 한 행씩 쓴다. 각 항목 행의 쉼표는 JSON 배열 규칙을 따른다. 읽기 도구는 이 행 배치를 검증한다.

```text
[
manifest,
page,
page
]
```

manifest는 `kind: "manifest"`, `format: "leader-cases/paged-bundle"`, `schemaVersion: 2`, `encoding: "gzip-base64"`와 필드 목록을 갖는다. 필드는 `BUNDLE_FIELDS`의 순서대로 정확히 한 번 나오며 이름·value/array 구분·원래 행 수·페이지 수를 기록한다.

페이지는 `kind: "page"`, 필드명 `field`, 필드 안 0부터의 `index`, 압축 전 UTF-8 크기 `bytes`, gzip의 base64 `data`를 갖는다. 압축을 풀면 `{field, index, value}`이며 바깥 식별자와 같아야 한다. 배열 페이지의 value는 연속된 원래 행들의 배열이다. 가격과 섹터는 시리즈 하나씩, 그 밖의 최상위 배열은 최대 128행씩 나눈다. 스칼라·객체 필드는 한 페이지다. 빈 배열은 0페이지와 길이 0이다.

페이지당 복원 한도는 16MiB다. 이를 넘는 단일 시리즈·객체가 생기면 `bundle_page_too_large`로 실패하며 원천을 자르지 않는다. 이번 대표 자료의 가장 큰 페이지는 이 한도 안이다. 훨씬 긴 기간이나 큰 독립 원천이 이 한도에 닿으면 해당 도메인 필드의 페이지 경계를 더 나누어야 한다.

검증은 manifest 필드 순서·누락·개수, 페이지 순서·중복·누락, base64 문법, 압축 체크섬, 복원 바이트 수와 상한, UTF-8·JSON, 압축 안팎 식별자, 배열 총길이, 논리 필드 타입과 날짜 정렬을 확인한다. Node와 브라우저는 복원한 페이지마다 논리 필드 파서를 적용해 큰 원본 객체와 전체 검증 복사본을 동시에 만들지 않는다. 여러 페이지를 다시 JSON 문자열 하나로 잇는 경로는 없다.

`readBundle(path)`는 디스크 문서에서 검증된 논리 Bundle을 반환한다. `readBundleDocument(path)`와 `documentBundle(document)`는 HTML 생성기가 압축 페이지를 다시 사용할 때 쓴다. `reportPage`는 전체 HTML 문자열 대신 문자열 조각의 generator를 반환한다. `writeAtomic`이 같은 디렉터리의 자기 임시 파일에 모든 조각을 쓴 뒤 rename한다. 시작·도중 쓰기 실패, 페이지 직렬화 실패, 잘못된 입력 모두 기존 정상 출력을 보존한다.

버전 1의 거대한 평문 Bundle을 읽는 임시 호환 경로는 없다. 기존 정상 파일은 실패로 덮어쓰지 않지만 새 도구로 소비하려면 새 형식으로 다시 수집해야 한다. 원고 `Manuscript`는 버전 1 그대로다.

## 통합 범위

main의 #172 merge `b7ffdd53d0d0b98156e8f5947f0bd908e665954b`를 통합한다. 원본 receipt는 최종 Y 공시 목록에 없을 수 있다. Node와 HTML 내장 페이지 복원 뒤 `dart` 전체 일치와 실제 브라우저 원본 링크를 확인하며, Y 목록에서 근거를 필터하거나 재구성하지 않는다. #175의 기존 주식수 표시 시점 문제는 이번 직렬화 수정 범위가 아니다. 실제 247540 재수집은 두 수정이 검증·병합된 뒤 #143 작업자가 한 번 수행한다.
