use server::shared_data::{CurrentQuotes, Ladder, LevelQty, LiveQuoteWriter, QuoteMinute, VenueQuote, read_quote_day};

const DATE: &str = "20261124";
const MINUTE: u16 = 541;
const CLOSE_SEC: u32 = 541 * 60 + 59;

fn ladder(asks: &[(i64, i64)], bids: &[(i64, i64)]) -> Ladder {
    Ladder {
        asks: asks.iter().map(|(price, qty)| LevelQty(*price, *qty)).collect(),
        bids: bids.iter().map(|(price, qty)| LevelQty(*price, *qty)).collect(),
    }
}

#[test]
fn a_finished_minute_wins_over_a_stale_current_minute_of_the_same_second() {
    let tmp = tempfile::tempdir().unwrap();
    let mut writer = LiveQuoteWriter::open(tmp.path(), DATE, "collect-01", 1).unwrap();

    let finished = QuoteMinute {
        minute: MINUTE,
        close_sec: CLOSE_SEC,
        single_price: true,
        combined: VenueQuote {
            close: ladder(&[(10_100, 12)], &[(9_900, 8)]),
            peak: ladder(&[(10_100, 50)], &[(9_900, 30)]),
            price_max: ladder(&[(10_100, 50), (10_200, 40)], &[(9_900, 30)]),
        },
        krx: VenueQuote {
            close: ladder(&[(10_100, 12)], &[(9_900, 8)]),
            peak: ladder(&[(10_100, 50)], &[(9_900, 30)]),
            price_max: ladder(&[(10_100, 50)], &[(9_900, 30)]),
        },
        nxt: VenueQuote::default(),
    };

    let stale_current = QuoteMinute {
        minute: MINUTE,
        close_sec: CLOSE_SEC,
        single_price: false,
        combined: VenueQuote {
            close: ladder(&[(10_100, 99)], &[(9_900, 77)]),
            peak: ladder(&[(10_100, 20)], &[(9_900, 10)]),
            price_max: ladder(&[(10_100, 80), (10_300, 5)], &[(9_900, 15), (9_800, 9)]),
        },
        krx: VenueQuote {
            close: ladder(&[(10_100, 99)], &[(9_900, 77)]),
            peak: ladder(&[(10_100, 70)], &[(9_900, 20)]),
            price_max: ladder(&[(10_100, 70)], &[(9_900, 20)]),
        },
        nxt: VenueQuote::default(),
    };

    writer.append_minute("005930", &finished).unwrap();
    let current = CurrentQuotes { minutes: [("005930".to_owned(), stale_current.clone())].into() };
    writer.write_current(&current, 2).unwrap();

    let day = read_quote_day(tmp.path(), DATE, "005930").unwrap().unwrap();
    assert!(!day.closed);
    assert_eq!(day.minutes.len(), 1);
    let actual = &day.minutes[0];
    assert_eq!(actual.close_sec, CLOSE_SEC);
    assert_eq!(actual.single_price, finished.single_price);
    assert_eq!(actual.combined.close, finished.combined.close);
    assert_eq!(actual.krx.close, finished.krx.close);
    assert_eq!(actual.combined.peak, finished.combined.peak);
    assert_eq!(actual.krx.peak, stale_current.krx.peak);
    assert_eq!(
        actual.combined.price_max,
        ladder(&[(10_100, 80), (10_200, 40), (10_300, 5)], &[(9_900, 30), (9_800, 9)])
    );
    assert_eq!(actual.krx.price_max, ladder(&[(10_100, 70)], &[(9_900, 30)]));
}
