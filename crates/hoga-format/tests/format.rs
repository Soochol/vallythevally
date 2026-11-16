mod json;

use hoga_format::{decode, encode, DecodeError, EncodeError, Span, Stream, StreamKind};
use json::Json;

const FIXTURE_BYTES: &[u8] = include_bytes!("fixtures/span-v1.hoga");
const FIXTURE_JSON: &str = include_str!("fixtures/span-v1.json");

fn stream_with_rows(kind: StreamKind, rows: usize) -> Stream {
    let columns = kind
        .columns()
        .iter()
        .enumerate()
        .map(|(column, _)| {
            (0..rows)
                .map(|row| match (column + row) % 4 {
                    0 => (row as i64) * 37 - 100,
                    1 => i32::MAX as i64 - row as i64,
                    2 => i32::MIN as i64 + row as i64,
                    _ => -(row as i64) * 1_000_003,
                })
                .collect()
        })
        .collect();
    Stream { kind, columns }
}

fn span_with(symbol: &str, streams: Vec<Stream>) -> Span {
    Span {
        date: 20260720,
        start_minute: 625,
        length_minutes: 5,
        symbol: symbol.to_string(),
        streams,
    }
}

fn all_streams(rows: usize) -> Vec<Stream> {
    StreamKind::ALL
        .into_iter()
        .map(|kind| stream_with_rows(kind, rows))
        .collect()
}

fn fixture_span() -> Span {
    let json = Json::parse(FIXTURE_JSON);
    let streams = json
        .field("streams")
        .array()
        .iter()
        .map(|stream| {
            let name = stream.field("kind").text();
            let kind = StreamKind::ALL
                .into_iter()
                .find(|kind| kind.name() == name)
                .unwrap_or_else(|| panic!("알 수 없는 흐름 {name}"));
            let columns = stream.field("columns").array();
            let expected: Vec<String> = kind.columns().into_iter().map(|spec| spec.name).collect();
            let names: Vec<&str> = columns.iter().map(|column| column.field("name").text()).collect();
            assert_eq!(names, expected, "{name} 열 이름과 순서");
            Stream {
                kind,
                columns: columns
                    .iter()
                    .map(|column| column.field("values").array().iter().map(Json::number).collect())
                    .collect(),
            }
        })
        .collect();
    Span {
        date: json.field("date").number() as u32,
        start_minute: json.field("start_minute").number() as u16,
        length_minutes: json.field("length_minutes").number() as u16,
        symbol: json.field("symbol").text().to_string(),
        streams,
    }
}

#[test]
fn 열_규격은_계획_문서의_열_수와_차분_여부를_따른다() {
    let counts: Vec<usize> = StreamKind::ALL.iter().map(|kind| kind.columns().len()).collect();
    assert_eq!(counts, [44, 5, 6, 21, 2]);
    let delta_names = |kind: StreamKind| -> Vec<String> {
        kind.columns().into_iter().filter(|spec| spec.delta).map(|spec| spec.name).collect()
    };
    assert_eq!(delta_names(StreamKind::Book).len(), 44);
    assert_eq!(delta_names(StreamKind::Trades), ["recv_ms", "t_s", "price"]);
    assert_eq!(delta_names(StreamKind::Program).len(), 6);
    assert_eq!(delta_names(StreamKind::Broker), ["recv_ms"]);
    assert!(delta_names(StreamKind::Gaps).is_empty());
    assert_eq!(StreamKind::Book.column_index("bid_px1"), Some(12));
    assert_eq!(StreamKind::Book.column_index("bid_total"), Some(43));
    assert_eq!(StreamKind::Broker.column_index("buy_qty5"), Some(20));
    let codes: Vec<u8> = StreamKind::ALL.iter().map(|kind| kind.code()).collect();
    assert_eq!(codes, [1, 2, 3, 4, 5]);
}

#[test]
fn 왕복_다섯_흐름은_행_0개_1개_여러_개_모두_같은_값이다() {
    for rows in [0, 1, 2, 7, 300] {
        let span = span_with("005930_AL", all_streams(rows));
        let bytes = encode(&span).unwrap();
        assert_eq!(decode(&bytes).unwrap(), span, "행 {rows}개");
    }
}

#[test]
fn 왕복_흐름은_하나만_담거나_비워도_된다() {
    let only_trades = span_with("005930", vec![stream_with_rows(StreamKind::Trades, 3)]);
    assert_eq!(decode(&encode(&only_trades).unwrap()).unwrap(), only_trades);
    let none = span_with("", vec![]);
    assert_eq!(decode(&encode(&none).unwrap()).unwrap(), none);
}

#[test]
fn 왕복_흐름_순서를_그대로_돌려준다() {
    let mut streams = all_streams(2);
    streams.reverse();
    let span = span_with("000660", streams);
    assert_eq!(decode(&encode(&span).unwrap()).unwrap(), span);
}

#[test]
fn 범위_초과_경계값은_통과한다() {
    let mut stream = stream_with_rows(StreamKind::Trades, 2);
    stream.columns[3] = vec![i32::MAX as i64, i32::MIN as i64];
    let span = span_with("005930", vec![stream]);
    assert_eq!(decode(&encode(&span).unwrap()).unwrap(), span);
}

#[test]
fn 범위_초과_최댓값_더하기_일은_흐름_열_행_값을_알려_준다() {
    let mut stream = stream_with_rows(StreamKind::Trades, 3);
    stream.columns[3][2] = i32::MAX as i64 + 1;
    let error = encode(&span_with("005930", vec![stream])).unwrap_err();
    assert_eq!(
        error,
        EncodeError::OutOfRange {
            kind: StreamKind::Trades,
            column: "qty".to_string(),
            row: 2,
            value: i32::MAX as i64 + 1,
        }
    );
    let message = error.to_string();
    for part in ["trades", "qty", "2행", "2147483648"] {
        assert!(message.contains(part), "{message}에 {part}가 없다");
    }
}

#[test]
fn 범위_초과_최솟값_빼기_일은_차분_열에서도_오류다() {
    let mut stream = stream_with_rows(StreamKind::Program, 2);
    stream.columns[4][0] = i32::MIN as i64 - 1;
    let error = encode(&span_with("005930", vec![stream])).unwrap_err();
    assert_eq!(
        error,
        EncodeError::OutOfRange {
            kind: StreamKind::Program,
            column: "buy_qty".to_string(),
            row: 0,
            value: i32::MIN as i64 - 1,
        }
    );
}

#[test]
fn 차분_감싸기_최솟값_다음_최댓값과_그_반대가_왕복한다() {
    for pair in [[i32::MIN as i64, i32::MAX as i64], [i32::MAX as i64, i32::MIN as i64]] {
        let mut stream = stream_with_rows(StreamKind::Book, 2);
        stream.columns[0] = pair.to_vec();
        stream.columns[43] = pair.to_vec();
        let span = span_with("005930", vec![stream]);
        let decoded = decode(&encode(&span).unwrap()).unwrap();
        assert_eq!(decoded, span);
    }
}

#[test]
fn 본문_정렬_종목_길이를_바꿔도_각_흐름의_본문_시작이_4의_배수다() {
    for symbol_len in (0..=12).chain([254, 255]) {
        let symbol = "A".repeat(symbol_len);
        let streams: Vec<Stream> = [StreamKind::Trades, StreamKind::Gaps, StreamKind::Book, StreamKind::Broker]
            .into_iter()
            .map(|kind| stream_with_rows(kind, 3))
            .collect();
        let bodies: Vec<usize> = streams.iter().map(|stream| stream.kind.columns().len() * 3 * 4).collect();
        let bytes = encode(&span_with(&symbol, streams)).unwrap();
        let mut start = bytes.len() - bodies.iter().sum::<usize>();
        for body in &bodies {
            assert_eq!(start % 4, 0, "종목 {symbol_len}글자");
            start += body;
        }
        assert_eq!(decode(&bytes).unwrap().symbol, symbol);
    }
}

#[test]
fn 인코더_거절_종목과_열_구조() {
    let ok = stream_with_rows(StreamKind::Trades, 2);
    assert_eq!(encode(&span_with("삼성전자", vec![ok.clone()])), Err(EncodeError::SymbolNotAscii));
    assert_eq!(
        encode(&span_with(&"A".repeat(256), vec![ok.clone()])),
        Err(EncodeError::SymbolTooLong { len: 256 })
    );
    assert_eq!(
        encode(&span_with("A", vec![ok.clone(), ok.clone()])),
        Err(EncodeError::DuplicateStream { kind: StreamKind::Trades })
    );

    let mut fewer = ok.clone();
    fewer.columns.pop();
    assert_eq!(
        encode(&span_with("A", vec![fewer])),
        Err(EncodeError::ColumnCount { kind: StreamKind::Trades, expected: 5, found: 4 })
    );

    let mut uneven = ok;
    uneven.columns[2].pop();
    assert_eq!(
        encode(&span_with("A", vec![uneven])),
        Err(EncodeError::ColumnLength {
            kind: StreamKind::Trades,
            column: "price".to_string(),
            expected: 2,
            found: 1,
        })
    );
}

#[test]
fn 기준_파일_인코더가_기준_json의_값으로_만든_바이트가_기준_파일과_같다() {
    assert_eq!(encode(&fixture_span()).unwrap(), FIXTURE_BYTES);
}

#[test]
fn 기준_파일_디코더가_기준_파일에서_기준_json의_값을_돌려준다() {
    assert_eq!(decode(FIXTURE_BYTES).unwrap(), fixture_span());
}

#[test]
fn 기준_파일은_계획한_경계를_모두_담고_있다() {
    let span = decode(FIXTURE_BYTES).unwrap();
    let kinds: Vec<StreamKind> = span.streams.iter().map(|stream| stream.kind).collect();
    assert_eq!(kinds, StreamKind::ALL);
    let start_ms = span.start_minute as i64 * 60_000;
    for kind in [StreamKind::Book, StreamKind::Program, StreamKind::Broker] {
        let first = span.stream(kind).unwrap().column("recv_ms").unwrap()[0];
        assert!(first < start_ms, "{} 이월 행", kind.name());
    }
    assert_eq!(span.stream(StreamKind::Gaps).unwrap().rows(), 0);
    let values: Vec<i64> = span.streams.iter().flat_map(|stream| stream.columns.iter().flatten().copied()).collect();
    assert!(values.contains(&(i32::MAX as i64)));
    assert!(values.contains(&(i32::MIN as i64)));
    assert!(values.iter().any(|value| *value < 0));
    let book = span.stream(StreamKind::Book).unwrap();
    let totals = book.column("ask_total").unwrap();
    assert_eq!((totals[0], totals[1]), (i32::MAX as i64, i32::MIN as i64));
}

fn corrupt(offset: usize, byte: u8) -> Vec<u8> {
    let mut bytes = FIXTURE_BYTES.to_vec();
    bytes[offset] = byte;
    bytes
}

const SYMBOL_LEN_OFFSET: usize = 14;
const STREAM_COUNT_OFFSET: usize = SYMBOL_LEN_OFFSET + 1 + 6;
const FIRST_ENTRY: usize = STREAM_COUNT_OFFSET + 1;

#[test]
fn 거절_다른_magic() {
    assert_eq!(decode(&corrupt(0, b'X')), Err(DecodeError::BadMagic));
}

#[test]
fn 거절_버전_2() {
    assert_eq!(decode(&corrupt(4, 2)), Err(DecodeError::UnsupportedVersion { version: 2 }));
    assert_eq!(decode(&corrupt(4, 0)), Err(DecodeError::UnsupportedVersion { version: 0 }));
}

#[test]
fn 거절_잘린_파일은_어느_길이에서도_오류이고_패닉하지_않는다() {
    for len in 0..FIXTURE_BYTES.len() {
        assert!(decode(&FIXTURE_BYTES[..len]).is_err(), "{len}바이트");
    }
}

#[test]
fn 거절_뒤에_바이트가_남는_파일() {
    let mut bytes = FIXTURE_BYTES.to_vec();
    bytes.push(0);
    assert_eq!(decode(&bytes), Err(DecodeError::TrailingBytes { count: 1 }));
}

#[test]
fn 거절_열_수가_규격과_다른_흐름() {
    assert_eq!(
        decode(&corrupt(FIRST_ENTRY + 1, 43)),
        Err(DecodeError::ColumnCount { kind: StreamKind::Book, expected: 44, found: 43 })
    );
}

const HEADER_LEN_BEFORE_SYMBOL: usize = 4 + 2 + 4 + 2 + 2 + 1;
const ENTRY_LEN_GAPS: usize = 1 + 1 + 4 + 4 + 1;

fn first_entry_offset(symbol_len: usize) -> usize {
    HEADER_LEN_BEFORE_SYMBOL + symbol_len + 1
}

#[test]
fn 거절_같은_종류가_두_번_든_파일() {
    let span = span_with("A", vec![stream_with_rows(StreamKind::Gaps, 1), stream_with_rows(StreamKind::Program, 1)]);
    let mut bytes = encode(&span).unwrap();
    bytes[first_entry_offset(1) + ENTRY_LEN_GAPS] = StreamKind::Gaps.code();
    assert_eq!(decode(&bytes), Err(DecodeError::DuplicateStream { kind: StreamKind::Gaps }));
}

#[test]
fn 거절_알_수_없는_종류_차분_여부_본문_길이_채움() {
    assert_eq!(decode(&corrupt(FIRST_ENTRY, 9)), Err(DecodeError::UnknownKind { code: 9 }));
    let flags = FIRST_ENTRY + 1 + 1 + 4 + 4;
    assert_eq!(
        decode(&corrupt(flags, 0)),
        Err(DecodeError::DeltaFlagsMismatch { kind: StreamKind::Book })
    );
    assert!(matches!(
        decode(&corrupt(FIRST_ENTRY + 2, 5)),
        Err(DecodeError::BodyLength { kind: StreamKind::Book, .. })
    ));
    let span = span_with("AB", vec![stream_with_rows(StreamKind::Gaps, 1)]);
    let mut bytes = encode(&span).unwrap();
    let padding_at = first_entry_offset(2) + ENTRY_LEN_GAPS;
    assert_eq!(padding_at % 4, 1);
    bytes[padding_at] = 1;
    assert_eq!(decode(&bytes), Err(DecodeError::NonZeroPadding));
}

#[test]
fn 거절_종목이_아스키가_아닌_파일() {
    let mut bytes = FIXTURE_BYTES.to_vec();
    bytes[SYMBOL_LEN_OFFSET + 1] = 0xC3;
    assert_eq!(decode(&bytes), Err(DecodeError::SymbolNotAscii));
}

#[test]
fn 거절_행_수가_엄청나게_큰_머리는_메모리를_잡지_않고_오류다() {
    let mut bytes = FIXTURE_BYTES.to_vec();
    let rows_at = FIRST_ENTRY + 2;
    bytes[rows_at..rows_at + 4].copy_from_slice(&u32::MAX.to_le_bytes());
    bytes[rows_at + 4..rows_at + 8].copy_from_slice(&u32::MAX.to_le_bytes());
    assert!(decode(&bytes).is_err());
}

#[test]
fn 거절_어느_한_바이트가_바뀌어도_패닉하지_않는다() {
    for offset in 0..FIXTURE_BYTES.len().min(200) {
        for byte in [0u8, 1, 0x7F, 0xFF] {
            let _ = decode(&corrupt(offset, byte));
        }
    }
}
