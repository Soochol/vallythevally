#!/usr/bin/env python3
"""Public NAVER daily prices with Yahoo corporate-action cross-check; stdlib only. Writes only assigned kosdaq-* files.
Run: /usr/bin/python3 docs/research/2026-11-08-market-leaders/fetch-kosdaq.py
--offline recomputes from preserved responses; --check checks delivered datasets.
"""
import argparse
import ast
import concurrent.futures
import datetime as dt
import hashlib
import json
from pathlib import Path
import urllib.request

ROOT = Path(__file__).resolve().parent
COMPANIES = [('seegene','씨젠','096530'), ('ecoprobm','에코프로비엠','247540'), ('wemade','위메이드','112040'), ('sugentech','수젠텍','253840')]
URL = 'https://query1.finance.yahoo.com/v8/finance/chart/{code}.KQ?period1=1561939200&period2=1688169600&interval=1d&events=div%2Csplits'

def write(name, data):
    (ROOT / name).write_text(json.dumps(data, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')

def collect(company, offline):
    ident,name,code=company
    url=URL.format(code=code)
    path=ROOT / f'kosdaq-yahoo-{code}.json'
    if not offline:
        req=urllib.request.Request(url, headers={'User-Agent':'Mozilla/5.0'})
        with urllib.request.urlopen(req, timeout=60) as response:
            raw=response.read()
        payload=json.loads(raw)
        assert payload['chart']['error'] is None
        path.write_bytes(raw)
    raw=path.read_bytes()
    data=json.loads(raw)['chart']['result'][0]
    values=data['indicators']['adjclose'][0]['adjclose']
    points=[]
    for timestamp,close in zip(data['timestamp'],values):
        date=dt.datetime.fromtimestamp(timestamp,dt.timezone.utc).date().isoformat()
        if close is not None and '2019-07-01' <= date <= '2023-06-30':
            points.append({'date':date,'close':round(close,8)})
    naver_url=f'https://api.finance.naver.com/siseJson.naver?symbol={code}&requestType=1&startTime=20190701&endTime=20230630&timeframe=day'
    naver_path=ROOT / f'kosdaq-naver-{code}.txt'
    if not offline:
        req=urllib.request.Request(naver_url, headers={'User-Agent':'Mozilla/5.0'})
        with urllib.request.urlopen(req,timeout=60) as response:
            naver_path.write_bytes(response.read())
    naver_raw=naver_path.read_bytes()
    rows=ast.literal_eval(naver_raw.decode('utf-8').strip())
    assert rows[0][:6]==['날짜','시가','고가','저가','종가','거래량']
    excluded=[{'date':r[0],'close':r[4],'volume':r[5]} for r in rows[1:] if r[5]<=0]
    points=[{'date':f'{r[0][:4]}-{r[0][4:6]}-{r[0][6:8]}','close':r[4]} for r in rows[1:] if r[5]>0 and r[4]>0]
    assert len(points)>900
    assert len({p['date'] for p in points}) == len(points)
    assert all(p['close']>0 for p in points)
    series={'id':ident,'name':name,'code':code,'market':'KOSDAQ','sourceUrl':naver_url,
      'priceBasis':'NAVER siseJson daily close, KRW; retrieval-time historical adjusted price series; not contemporaneous unadjusted close and not a verified dividend-reinvestment total-return series',
      'adjustments':{'provider':'NAVER Finance','retrieved':dt.datetime.fromtimestamp(naver_path.stat().st_mtime,dt.timezone.utc).isoformat(),'dividendsIncluded':None,'description':'Historical split/bonus-share adjustment observed across corporate-action dates. Exact provider formula, cash-dividend treatment and paid-in-capital/rights adjustment not independently confirmed; do not describe as total return. All comparisons use this same NAVER close field. Current series may change after later events.','reportedEventsWithinRequestedPeriod':data.get('events',{}),'corporateActionCrossCheckProvider':'Yahoo Finance; events used only as secondary cross-check, not mixed into main prices','corporateActionCrossCheckUrl':url,'yahooRawFile':path.name,'yahooRawSha256':hashlib.sha256(raw).hexdigest(),'rawFile':naver_path.name,'rawSha256':hashlib.sha256(naver_raw).hexdigest(),'excludedZeroVolumeRows':excluded},
      'points':points}
    window=[p for p in points if '2020-01-01'<=p['date']<='2022-12-31']
    peak=max(window,key=lambda p:p['close'])
    after=[p for p in points if p['date']>peak['date']]
    trough=min(after,key=lambda p:p['close'])
    end22=max((p for p in points if p['date']<='2022-12-31'),key=lambda p:p['date'])
    end23=points[-1]
    def change(p):return round((p['close']/peak['close']-1)*100,6)
    annual={}
    for year in (2020,2021,2022):
        prev=max((p for p in points if p['date']<f'{year}-01-01'),key=lambda p:p['date'])
        end=max((p for p in points if p['date']<=f'{year}-12-31'),key=lambda p:p['date'])
        annual[str(year)]={'start':prev,'end':end,'adjustedPriceChangePct':round((end['close']/prev['close']-1)*100,6)}
    metrics={'observationWindow':['2020-01-01','2022-12-31'],'peakClose2020to2022':peak,'subsequentMinimumThrough2023H1':trough,'peakToSubsequentMinimumPct':change(trough),'end2022':end22,'peakToEnd2022Pct':change(end22),'end2023H1':end23,'peakToEnd2023H1Pct':change(end23),'highestClose2023H1':max((p for p in points if p['date']>='2023-01-01'),key=lambda p:p['close']),'annualAdjustedPriceChanges':annual,'pointCount':len(points),'firstDate':points[0]['date'],'lastDate':points[-1]['date'],'formula':'100*(target adjusted close / peak adjusted close - 1); peak restricted to 2020-2022, minimum strictly after peak through 2023-06-30. This is not all-period maximum drawdown.'}
    return series,metrics

def check(include_report=True):
    prices=json.loads((ROOT/'kosdaq-prices.json').read_text())
    metrics=json.loads((ROOT/'kosdaq-metrics.json').read_text())
    assert len(prices['series'])==4
    for s in prices['series']:
        pts=s['points']; assert pts==sorted(pts,key=lambda p:p['date'])
        assert len(pts)>900 and all(p['close']>0 for p in pts)
        assert len({p['date'] for p in pts})==len(pts)
        assert pts[0]['date']=='2019-07-01' and pts[-1]['date']=='2023-06-30'
        adj=s['adjustments']
        raw=(ROOT/adj['rawFile']).read_bytes()
        assert hashlib.sha256(raw).hexdigest()==adj['rawSha256']
        rows=ast.literal_eval(raw.decode('utf-8').strip())
        retained=[{'date':f'{r[0][:4]}-{r[0][4:6]}-{r[0][6:8]}','close':r[4]} for r in rows[1:] if r[5]>0 and r[4]>0]
        assert pts==retained
        assert hashlib.sha256((ROOT/adj['yahooRawFile']).read_bytes()).hexdigest()==adj['yahooRawSha256']
        m=metrics[s['id']]; peak=max((p for p in pts if '2020-01-01'<=p['date']<='2022-12-31'),key=lambda p:p['close'])
        assert peak==m['peakClose2020to2022']
        trough=min((p for p in pts if p['date']>peak['date']),key=lambda p:p['close'])
        assert trough==m['subsequentMinimumThrough2023H1']
        for key,value in [('subsequentMinimumThrough2023H1','peakToSubsequentMinimumPct'),('end2022','peakToEnd2022Pct'),('end2023H1','peakToEnd2023H1Pct')]:
            assert abs(m[value]-100*(m[key]['close']/peak['close']-1))<1e-5
        assert m['end2023H1']==pts[-1]
        assert m['end2022']==max((p for p in pts if p['date']<='2022-12-31'),key=lambda p:p['date'])
        assert abs(m['peakToEnd2022Pct']-100*(m['end2022']['close']/peak['close']-1))<1e-5
    p=ROOT/'kosdaq.json'
    if p.exists() and include_report:
        report=json.loads(p.read_text()); assert len(report['cases'])==4
        source_map={x['id']:x for x in report['sources']}
        sources=set(source_map)
        assert len(sources)==len(report['sources'])
        for c in report['cases']:
            assert c['metrics']==metrics[c['id']]
            for item in [c,*c['events'],*c['phases'],*c['asOf']]:
                assert set(item['sourceIds'])<=sources
            assert 3<=len(c['events'])<=5
            assert set(c['comparisonSourceIds'])<=sources
            for a in c['asOf']:
                assert a['date'] in ['2020-06-30','2021-06-30','2022-06-30']
                for ident in a['sourceIds']:
                    assert source_map[ident]['published']<=a['date'], (ident,a['date'])
        note=(ROOT/'kosdaq.md').read_text()
        assert all(x['name'] in note for x in report['cases'])
        assert all(x['url'] in note for x in report['sources'])
    print('PASS: four series; source SHA256; zero-volume exclusion; ordered unique dates; peaks, subsequent minima and endpoints; report source IDs; asOf publication cutoffs')

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--offline',action='store_true');parser.add_argument('--check',action='store_true');args=parser.parse_args()
    if args.check:check()
    else:
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            result=list(pool.map(lambda c:collect(c,args.offline),COMPANIES))
        write('kosdaq-prices.json',{'series':[r[0] for r in result]})
        write('kosdaq-metrics.json',{r[0]['id']:r[1] for r in result})
        check(include_report=False)
        for s,m in result:print(s['name'],json.dumps(m,ensure_ascii=False))
