#!/usr/bin/env python3
"""Public, credential-free price collection and reproducible calculations.

python3 fetch-kospi.py              # refresh the frozen raw responses
python3 fetch-kospi.py --offline    # rebuild from saved responses
python3 fetch-kospi.py --check      # verify derived files, without network/writes
python3 fetch-kospi.py --audit-sources  # open all cited direct URLs; save HTTP/hash audit
"""
import argparse
import ast
import datetime as dt
import hashlib
import json
from pathlib import Path
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parent
KST = dt.timezone(dt.timedelta(hours=9))
ITEMS = [('samsung', '삼성전자', '005930'), ('naver', 'NAVER', '035420'),
         ('lgchem', 'LG화학', '051910'), ('kakao', '카카오', '035720'),
         ('kospi', 'KOSPI', '^KS11')]


def read_url(url):
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    with urllib.request.urlopen(req, timeout=45) as response:
        return response.read()


def urls(code):
    symbol = code if code.startswith('^') else code + '.KS'
    start = int(dt.datetime(2019, 7, 1, tzinfo=KST).timestamp())
    end = int(dt.datetime(2023, 7, 1, tzinfo=KST).timestamp())
    yahoo = 'https://query1.finance.yahoo.com/v8/finance/chart/' + urllib.parse.quote(symbol)
    yahoo += '?' + urllib.parse.urlencode(dict(period1=start, period2=end, interval='1d', events='div,splits'))
    naver = 'https://api.finance.naver.com/siseJson.naver?' + urllib.parse.urlencode(dict(
        symbol='KOSPI' if code.startswith('^') else code, requestType=1, startTime='20190701', endTime='20230630', timeframe='day'))
    return yahoo, naver


def load_prices(refresh):
    series, checks, manifest = [], [], []
    for ident, name, code in ITEMS:
        yahoo, naver = urls(code)
        path = ROOT / f'kospi-raw-{ident}-yahoo.json'
        if refresh:
            path.write_bytes(read_url(yahoo))
        raw = path.read_bytes()
        result = json.loads(raw)['chart']['result'][0]
        quote = result['indicators']['quote'][0]['close']
        points = []
        for timestamp, value in zip(result['timestamp'], quote):
            date = dt.datetime.fromtimestamp(timestamp, KST).date().isoformat()
            if value is not None and '2019-07-01' <= date <= '2023-06-30':
                points.append(dict(date=date, close=round(value, 6)))
        assert points and len(points) == len({p['date'] for p in points})
        assert points == sorted(points, key=lambda p: p['date'])
        assert all(p['close'] > 0 for p in points)
        adjustments = {
            'basis': 'Yahoo quote.close: 주식분할 반영 종가, 현금배당 미포함; adjclose 사용 안 함',
            'snapshotLimitation': '수집 시점 공급자가 제공한 과거 시계열이며 당시 원시 테이프가 아님; 보존 원본 SHA-256과 연구 출처 확인일 참조',
            'providerEvents': result.get('events', {}),
            'manualAdjustments': '없음; 공급자의 주식분할 조정을 중복 적용하지 않음',
        }
        series.append(dict(id=ident, name=name, code=code, market='KOSPI', sourceUrl=yahoo,
                           priceBasis='KRW, split-adjusted close; cash dividends excluded' if ident != 'kospi'
                           else 'KOSPI price index points; dividends excluded',
                           adjustments=adjustments, points=points))
        manifest.append(dict(id=ident, url=yahoo, file=path.name, sha256=hashlib.sha256(raw).hexdigest(),
                             points=len(points), first=points[0]['date'], last=points[-1]['date']))
        other = ROOT / f'kospi-raw-{ident}-naver.txt'
        if refresh:
            other.write_bytes(read_url(naver))
        rows = ast.literal_eval(other.read_text().strip())
        lookup = {f'{r[0][:4]}-{r[0][4:6]}-{r[0][6:]}': float(r[4]) for r in rows[1:] if len(r) > 4}
        observed = [dict(date=f'{r[0][:4]}-{r[0][4:6]}-{r[0][6:]}', close=float(r[4]))
                    for r in rows[1:] if len(r) > 5 and float(r[5]) > 0]
        assert observed and len(observed) == len({p['date'] for p in observed})
        assert observed == sorted(observed, key=lambda p: p['date'])
        assert all(p['close'] > 0 for p in observed)
        assert observed[0]['date'] == '2019-07-01'
        assert observed[-1]['date'] == '2023-06-30'
        series[-1].update(sourceUrl=naver, points=observed,
                          priceBasis='NAVER 현재 제공 과거 종가(기업행사 조정); 원; 현금배당을 별도 가산·재투자하지 않음; 공급자 배당조정 여부 문서 미확보'
                          if ident != 'kospi' else 'NAVER KOSPI 가격지수 종가, 포인트; 배당 포함 총수익지수 아님')
        adjustments.update(basis='NAVER 제공 과거 종가를 그대로 사용; 주식분할 반영 시계열',
                           manualAdjustments='가격 수동보정·보간 없음; 거래량 0 행은 관측 거래종가에서 제외',
                           dividendPolicy='현금배당 가산·재투자 계산 없음; NAVER 세부 조정 산식·배당조정 포함여부 문서 미확보',
                           providerEventsNote='providerEvents는 Yahoo의 비교용 기업행사 목록이며 NAVER 조정계수 감사자료가 아님',
                           removedZeroVolumeDates=[r[0] for r in rows[1:] if len(r) > 5 and float(r[5]) == 0])
        if ident == 'kakao':
            adjustments['splitCaution'] = '2021-04-15 5:1 분할(Yahoo), 회사 기준일 04-14. 분할 이전 NAVER는 Yahoo 단순 1/5 환산값보다 약 0.36% 높음; 정확한 차이 산식 미확인. 두 공급자를 혼합하지 않음.'
        manifest.append(dict(id=ident+'-naver', url=naver, file=other.name,
                             sha256=hashlib.sha256(other.read_bytes()).hexdigest(),
                             points=len(observed), first=observed[0]['date'], last=observed[-1]['date']))
        diffs = [dict(date=p['date'], yahoo=p['close'], naver=lookup[p['date']]) for p in points
                 if p['date'] in lookup and abs(p['close'] - lookup[p['date']]) > 0.1]
        checks.append(dict(id=ident, sourceUrl=naver, compared=sum(p['date'] in lookup for p in points),
                           mismatchCount=len(diffs), mismatches=diffs,
                           note='최종 시계열은 NAVER. 비교자료 Yahoo에는 거래량 0·전일값 반복 및 일부 다른 종가가 있음. 카카오 분할 전 조정 차이 존재. 양 공급자가 동일 원천일 수 있어 독립 원장 검증은 아님'))
    return dict(series=series), checks, manifest


def peak(points, start='2020-01-01', end='2022-12-31'):
    subset = [p for p in points if start <= p['date'] <= end]
    value = max(p['close'] for p in subset)
    ties = [p for p in subset if p['close'] == value]
    return dict(date=ties[0]['date'], close=value, allDates=[p['date'] for p in ties])


def compute(prices):
    index = next(s for s in prices['series'] if s['id'] == 'kospi')
    index_peak = peak(index['points'])
    index_lookup = {p['date']: p['close'] for p in index['points']}
    out = {'indexPeak': index_peak, 'cases': {}}
    for s in prices['series']:
        points = s['points']
        top = peak(points)
        low = min((p for p in points if '2020-01-01' <= p['date'] <= top['date']), key=lambda p: p['close'])
        end22 = [p for p in points if p['date'] <= '2022-12-31'][-1]
        end23 = [p for p in points if p['date'] <= '2023-06-30'][-1]
        after = [p for p in points if top['date'] <= p['date'] <= '2023-06-30']
        trough = min(after, key=lambda p: p['close'])
        first20 = [p for p in points if p['date'] >= '2020-01-01'][0]
        stats = dict(peak=top, prePeakTrough=low, close2022=end22, close2023H1=end23,
                     postPeakTrough=trough, first2020=first20,
                     riseFromPrePeakTroughPct=round((top['close']/low['close']-1)*100, 6),
                     peakTo2022Pct=round((end22['close']/top['close']-1)*100, 6),
                     peakTo2023H1Pct=round((end23['close']/top['close']-1)*100, 6),
                     peakToSubsequentTroughPct=round((trough['close']/top['close']-1)*100, 6),
                     peakVsIndexCalendarDays=(dt.date.fromisoformat(top['date'])-dt.date.fromisoformat(index_peak['date'])).days,
                     priceReturn2020To2022Pct=round((end22['close']/first20['close']-1)*100, 6))
        stats.update(return2023H1Pct=round((end23['close']/end22['close']-1)*100, 6),
                     relativePeakTo2022Pct=round(((end22['close']/top['close']) /
                         (index_lookup[end22['date']]/index_lookup[top['date']])-1)*100, 6),
                     relativePeakTo2023H1Pct=round(((end23['close']/top['close']) /
                         (index_lookup[end23['date']]/index_lookup[top['date']])-1)*100, 6),
                     relative2023H1Pct=round(((end23['close']/end22['close']) /
                         (index_lookup[end23['date']]/index_lookup[end22['date']])-1)*100, 6))
        for year in (2020, 2021, 2022):
            annual = [p for p in points if f'{year}-01-01' <= p['date'] <= f'{year}-12-31']
            stats[f'year{year}Peak'] = peak(points, f'{year}-01-01', f'{year}-12-31')
            stats[f'year{year}Last'] = annual[-1]
        out['cases'][s['id']] = stats
    return out


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--offline', action='store_true')
    parser.add_argument('--check', action='store_true')
    parser.add_argument('--audit-sources', action='store_true')
    args = parser.parse_args()
    if args.audit_sources:
        research = json.loads((ROOT / 'kospi.json').read_text())
        audit_date = dt.datetime.now(KST).date().isoformat()
        audit = []
        for source in research['sources']:
            try:
                raw = read_url(source['url'])
                audit.append(dict(id=source['id'], url=source['url'], accessed=audit_date,
                                  status='opened', bytes=len(raw), sha256=hashlib.sha256(raw).hexdigest()))
            except Exception as error:
                audit.append(dict(id=source['id'], url=source['url'], accessed=audit_date,
                                  status='failed', error=str(error)))
        (ROOT / 'kospi-source-audit.json').write_text(json.dumps(audit, ensure_ascii=False, indent=2) + '\n')
        print(json.dumps(audit, ensure_ascii=False, indent=2))
        return
    prices, crosscheck, manifest = load_prices(not (args.offline or args.check))
    outputs = {'kospi-prices.json': prices, 'kospi-metrics.json': compute(prices),
               'kospi-price-checks.json': crosscheck, 'kospi-price-manifest.json': manifest}
    for name, data in outputs.items():
        path = ROOT / name
        if args.check:
            assert json.loads(path.read_text()) == data, f'derived output mismatch: {name}'
        else:
            path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n')
    report = ROOT / 'kospi.json'
    if args.check and report.exists():
        research = json.loads(report.read_text())
        ids = {s['id'] for s in research['sources']}
        source_map = {s['id']: s for s in research['sources']}
        assert len(ids) == len(research['sources'])
        for case in research['cases']:
            assert case['metrics'] == outputs['kospi-metrics.json']['cases'][case['id']]
            assert 3 <= len(case['events']) <= 5
            for item in [case, *case['phases'], *case['events'], *case['asOf']]:
                assert set(item['sourceIds']) <= ids
            for snapshot in case['asOf']:
                assert snapshot['date'] in ('2020-06-30', '2021-06-30', '2022-06-30')
                assert all(source_map[i].get('published', '9999-12-31') <= snapshot['date']
                           for i in snapshot['sourceIds']), 'future/unpublished source in asOf'
        assert len(research['cases']) == 4
    print(json.dumps({'status': 'verified' if args.check else 'written',
                      'series': {s['id']: len(s['points']) for s in prices['series']},
                      'crosscheck': [{k: v for k, v in c.items() if k != 'mismatches'} for c in crosscheck],
                      'metrics': outputs['kospi-metrics.json']}, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
