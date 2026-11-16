use std::fs::File;
use std::io::{BufRead, BufReader};
use std::process::ExitCode;

use collector::args::{ArgSpec, Arguments};
use collector::raw_write::{RawLine, RawWriter};
use serde::Deserialize;
use serde_json::value::RawValue;

const SPEC: ArgSpec = ArgSpec {
    value_options: &["input"],
    flag_options: &[],
};

#[derive(Deserialize)]
struct CaptureLine<'a> {
    recv_ms: i64,
    #[serde(borrow)]
    msg: Option<&'a RawValue>,
    #[serde(borrow)]
    values: Option<&'a RawValue>,
    #[serde(rename = "type", borrow)]
    real_type: Option<&'a RawValue>,
    #[serde(borrow)]
    name: Option<&'a RawValue>,
    #[serde(borrow)]
    item: Option<&'a RawValue>,
}

fn frame_text(line: &CaptureLine<'_>) -> Result<String, String> {
    if let Some(message) = line.msg {
        return Ok(message.get().to_string());
    }
    match (line.values, line.real_type, line.name, line.item) {
        (Some(values), Some(real_type), Some(name), Some(item)) => Ok(format!(
            "{{\"trnm\":\"REAL\",\"data\":[{{\"values\":{},\"type\":{},\"name\":{},\"item\":{}}}]}}",
            values.get(),
            real_type.get(),
            name.get(),
            item.get()
        )),
        _ => Err("msg도 항목 필드도 없는 줄입니다".to_string()),
    }
}

fn import(arguments: &Arguments) -> Result<usize, String> {
    let input = arguments.value("input").ok_or("--input <채록 파일>이 필요합니다")?;
    let reader = BufReader::new(File::open(input).map_err(|error| format!("{input}: {error}"))?);
    let mut writer = RawWriter::new(arguments.data_dir());
    let mut written = 0;
    for (index, line) in reader.lines().enumerate() {
        let line = line.map_err(|error| error.to_string())?;
        if line.trim().is_empty() {
            continue;
        }
        let number = index + 1;
        let capture: CaptureLine<'_> =
            serde_json::from_str(&line).map_err(|error| format!("{number}번째 줄: {error}"))?;
        let text = frame_text(&capture).map_err(|error| format!("{number}번째 줄: {error}"))?;
        writer
            .write(&RawLine::Frame { recv_ms: capture.recv_ms, text: &text })
            .map_err(|error| error.to_string())?;
        written += 1;
    }
    writer.close().map_err(|error| error.to_string())?;
    Ok(written)
}

fn main() -> ExitCode {
    let raw_arguments: Vec<String> = std::env::args().skip(1).collect();
    let result = Arguments::parse(&raw_arguments, &SPEC)
        .map_err(|error| error.to_string())
        .and_then(|arguments| import(&arguments));
    match result {
        Ok(written) => {
            println!("{written}줄을 썼습니다");
            ExitCode::SUCCESS
        }
        Err(message) => {
            eprintln!("import_capture: {message}");
            ExitCode::FAILURE
        }
    }
}
