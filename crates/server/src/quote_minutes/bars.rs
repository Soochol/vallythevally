use std::collections::BTreeMap;

use domain::{KstDate, KstTime, Period};

use super::{QuoteDepthPoint, QuoteDepthSource, QuoteTotalPoint};
use crate::api::UnixSeconds;
use crate::clock::kst;
use crate::shared_data::{Ladder, MinuteVenue, QuoteDay, QuoteMinute};

pub fn total_points(date: KstDate, day: &QuoteDay, period: Period, venue: MinuteVenue, now: KstTime, after: Option<i64>) -> Vec<QuoteTotalPoint> {
    let mut points = Vec::new();
    walk_bars(date, day, period, now, |t, slice, prev, bar_end_sec| {
        if after.is_some_and(|limit| t < limit) {
            return;
        }
        let close = match slice.last() {
            Some(last) => {
                if !is_valid_minute(last, venue) {
                    return;
                }
                &last.venue(venue).close
            }
            None => {
                let Some(prev_minute) = prev else { return };
                if !is_valid_minute(prev_minute, venue) || has_gap(&day.gaps, prev_minute.close_sec, bar_end_sec) {
                    return;
                }
                &prev_minute.venue(venue).close
            }
        };
        points.push(QuoteTotalPoint { t: UnixSeconds(t), ask: close.ask_total(), bid: close.bid_total() });
    });
    points
}

pub fn depth_points(date: KstDate, day: &QuoteDay, period: Period, venue: MinuteVenue, source: QuoteDepthSource, now: KstTime, after: Option<i64>) -> Vec<QuoteDepthPoint> {
    let mut points = Vec::new();
    walk_bars(date, day, period, now, |t, slice, prev, bar_end_sec| {
        if after.is_some_and(|limit| t < limit) {
            return;
        }
        let point = match slice.last() {
            Some(last) => {
                if !is_valid_minute(last, venue) {
                    return;
                }
                match source {
                    QuoteDepthSource::Close => Some(ladder_to_point(t, &last.venue(venue).close)),
                    QuoteDepthSource::Peak => pick_peak(slice, venue).map(|ladder| ladder_to_point(t, ladder)),
                    QuoteDepthSource::PriceMax => merge_price_max(t, slice, venue),
                }
            }
            None => {
                let Some(prev_minute) = prev else { return };
                if !is_valid_minute(prev_minute, venue) || has_gap(&day.gaps, prev_minute.close_sec, bar_end_sec) {
                    return;
                }
                Some(ladder_to_point(t, &prev_minute.venue(venue).close))
            }
        };
        if let Some(point) = point {
            points.push(point);
        }
    });
    points
}

fn walk_bars(
    date: KstDate,
    day: &QuoteDay,
    period: Period,
    now: KstTime,
    on_bar: impl FnMut(i64, &[QuoteMinute], Option<&QuoteMinute>, u32),
) {
    if day.minutes.is_empty() {
        return;
    }
    if day.minutes.windows(2).all(|pair| pair[0].minute <= pair[1].minute) {
        walk_sorted_bars(date, day.closed, &day.minutes, period, now, on_bar);
    } else {
        let mut sorted = day.minutes.clone();
        sorted.sort_unstable_by_key(|minute| minute.minute);
        walk_sorted_bars(date, day.closed, &sorted, period, now, on_bar);
    }
}

fn walk_sorted_bars(
    date: KstDate,
    closed: bool,
    minutes: &[QuoteMinute],
    period: Period,
    now: KstTime,
    mut on_bar: impl FnMut(i64, &[QuoteMinute], Option<&QuoteMinute>, u32),
) {
    let day_start = kst(date, 0, 0, 0);
    let minute_time = |minute: u16| day_start.plus_secs(i64::from(minute) * 60);
    let session_close = kst(date, 20, 0, 0);
    let end_limit = if closed { session_close } else { session_close.min(period.bucket(now).end()) };
    let mut bucket = period.bucket(minute_time(minutes[0].minute));
    let mut cursor = 0usize;
    let mut prev: Option<&QuoteMinute> = None;
    while bucket.start() < end_limit {
        let bar_end_time = bucket.end();
        let bar_start = cursor;
        while cursor < minutes.len() && minute_time(minutes[cursor].minute) < bar_end_time {
            cursor += 1;
        }
        let slice = &minutes[bar_start..cursor];
        let bar_end_sec = (bar_end_time.unix() - day_start.unix()) as u32;
        on_bar(bucket.start().unix(), slice, prev, bar_end_sec);
        if let Some(last) = slice.last() {
            prev = Some(last);
        }
        bucket = bucket.next();
    }
}

fn is_valid_minute(minute: &QuoteMinute, venue: MinuteVenue) -> bool {
    !minute.single_price && !minute.venue(venue).close.is_empty()
}

fn has_gap(gaps: &[(u32, u32)], prev_close_sec: u32, bar_end_sec: u32) -> bool {
    gaps.iter().any(|&(start, _)| start >= prev_close_sec && start < bar_end_sec)
}

fn ladder_to_point(t: i64, ladder: &Ladder) -> QuoteDepthPoint {
    QuoteDepthPoint {
        t: UnixSeconds(t),
        asks: ladder.asks.iter().map(|level| (level.0, level.1)).collect(),
        bids: ladder.bids.iter().map(|level| (level.0, level.1)).collect(),
    }
}

fn pick_peak<'a>(slice: &'a [QuoteMinute], venue: MinuteVenue) -> Option<&'a Ladder> {
    let mut best: Option<(i64, &'a Ladder)> = None;
    for minute in slice {
        let ladder = &minute.venue(venue).peak;
        if ladder.is_empty() {
            continue;
        }
        let total = ladder.ask_total() + ladder.bid_total();
        if best.is_none_or(|(best_total, _)| total > best_total) {
            best = Some((total, ladder));
        }
    }
    best.map(|(_, ladder)| ladder)
}

fn merge_price_max(t: i64, slice: &[QuoteMinute], venue: MinuteVenue) -> Option<QuoteDepthPoint> {
    let mut asks = BTreeMap::<i64, i64>::new();
    let mut bids = BTreeMap::<i64, i64>::new();
    for minute in slice {
        let ladder = &minute.venue(venue).price_max;
        for level in &ladder.asks {
            let entry = asks.entry(level.0).or_insert(0);
            if level.1 > *entry {
                *entry = level.1;
            }
        }
        for level in &ladder.bids {
            let entry = bids.entry(level.0).or_insert(0);
            if level.1 > *entry {
                *entry = level.1;
            }
        }
    }
    if asks.is_empty() && bids.is_empty() {
        return None;
    }
    Some(QuoteDepthPoint {
        t: UnixSeconds(t),
        asks: asks.into_iter().collect(),
        bids: bids.into_iter().rev().collect(),
    })
}
