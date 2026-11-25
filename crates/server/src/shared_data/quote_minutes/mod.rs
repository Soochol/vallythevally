mod files;
mod fold;
mod read;

pub use files::{ClosedQuotes, CurrentQuotes, LiveQuoteWriter, closed_day_dir, live_day_dir, write_closed_quotes};
pub use fold::{BOOK_DEPTH, BookLevel, BookRow, Ladder, LevelQty, QuoteMinute, QuoteMinuteBuilder, VenueQuote};
pub use read::{QuoteDay, live_quote_days_for_stock, live_quote_stock_keys, quote_days, read_quote_day};

#[cfg(test)]
mod tests {
    use domain::KstTime;

    use super::*;
    use crate::shared_data::{DataKind, SharedData};

    #[test]
    fn json_uses_camel_case_and_omits_empty_ladders() {
        let minute = QuoteMinute {
            minute: 540,
            close_sec: 32_459,
            single_price: false,
            combined: VenueQuote {
                close: Ladder { asks: vec![LevelQty(10_100, 5)], bids: Vec::new() },
                peak: Ladder::default(),
                price_max: Ladder { asks: vec![LevelQty(10_100, 5)], bids: Vec::new() },
            },
            krx: VenueQuote::default(),
            nxt: VenueQuote::default(),
        };
        let json = serde_json::to_string(&minute).unwrap();
        assert!(json.contains("\"closeSec\":32459"));
        assert!(json.contains("\"singlePrice\":false"));
        assert!(json.contains("\"priceMax\""));
        assert!(!json.contains("\"peak\""));
        assert!(!json.contains("\"bids\""));
        assert!(!json.contains("\"krx\""));
        assert!(!json.contains("\"nxt\""));
        let roundtrip: QuoteMinute = serde_json::from_str(&json).unwrap();
        assert_eq!(roundtrip, minute);
    }

    #[test]
    fn data_kind_and_shared_data_handle_quote_minutes() {
        assert_eq!(DataKind::QuoteMinutes.folder(), "quote-minutes");
        assert!(DataKind::ALL.contains(&DataKind::QuoteMinutes));
        let shared = SharedData::new();
        assert_eq!(shared.error_count(DataKind::QuoteMinutes), 0);
        assert_eq!(shared.age_secs(DataKind::QuoteMinutes, KstTime::from_unix(100)), None);
    }

    #[test]
    fn live_writer_sync_succeeds_with_open_files() {
        let tmp = tempfile::tempdir().unwrap();
        let mut writer = LiveQuoteWriter::open(tmp.path(), "20261124", "collect-01", 1).unwrap();
        writer.sync().unwrap();
        let minute = QuoteMinute {
            minute: 540,
            close_sec: 32_459,
            single_price: true,
            combined: VenueQuote::default(),
            krx: VenueQuote::default(),
            nxt: VenueQuote::default(),
        };
        writer.append_minute("005930", &minute).unwrap();
        writer.append_gap(32_400, 32_410).unwrap();
        writer.sync().unwrap();
    }
}
