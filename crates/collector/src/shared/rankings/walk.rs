use server::api::{MAX_RANKING_PAGES, Ranking};
use server::market_source::Cursor;
use server::market_source::rankings::{Demand, RankedRow, RankingFetch, RankingSource};

pub(super) struct Walked {
    pub rows: Vec<RankedRow>,
    pub page_rows: Vec<u32>,
    pub pages: u8,
    pub end: bool,
    pub limited: bool,
}

pub(super) async fn walk(source: &dyn RankingSource, ranking: &Ranking, wanted: u8, demand: &mut Demand) -> Result<Walked, String> {
    let mut rows = Vec::new();
    let mut page_rows = Vec::new();
    let mut used: Vec<Cursor> = Vec::new();
    let mut pages = 0u8;
    let mut cursor: Option<Cursor> = None;
    let mut end = false;
    while pages < wanted {
        let RankingFetch { rows: fetched, next, continues_without_cursor } = source.page(ranking, cursor.as_ref(), demand).await.map_err(|error| format!("{error:?}"))?;
        used.extend(cursor.take());
        page_rows.push(u32::try_from(fetched.len()).unwrap_or(u32::MAX));
        rows.extend(fetched);
        pages += 1;
        match next {
            Some(key) if used.contains(&key) => return Err("연속조회 키가 되풀이돼 끝까지 받지 못했습니다".to_owned()),
            Some(key) => cursor = Some(key),
            None if continues_without_cursor => return Err("다음 페이지가 있다고 하면서 연속조회 키를 주지 않았습니다".to_owned()),
            None => {
                end = true;
                break;
            }
        }
    }
    Ok(Walked { rows, page_rows, pages, end, limited: !end && pages == MAX_RANKING_PAGES })
}
