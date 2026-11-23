use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use domain::{KstDate, KstTime};
use server::shared_data::{Broker, DataKind, Header, SnapshotBody, SnapshotRow, SourceKey, write_snapshot};

use super::VenueName;
use super::fetch::Part;

const PARTS_FOLDER: &str = "snapshot-parts";
const KINDS: [DataKind; 3] = [DataKind::SnapshotKrx, DataKind::SnapshotCombined, DataKind::SnapshotNxt];

fn parts_dir(shared_dir: &Path) -> PathBuf {
    shared_dir.join(PARTS_FOLDER)
}

fn part_path(shared_dir: &Path, date: &str, tick: i64, index: u32, count: u32) -> PathBuf {
    parts_dir(shared_dir).join(format!("{date}.{tick}.{index}-{count}.json"))
}

pub(super) fn publish(shared_dir: &Path, observation_date: KstDate, part: Part, now: KstTime) -> io::Result<()> {
    let date = observation_date.yyyymmdd();
    let tick = part.tick;
    let complete = match part.slice_count {
        0 | 1 => vec![part],
        count => {
            write_part(shared_dir, &date, &part)?;
            match read_all(shared_dir, &date, part, count)? {
                Some(all) => all,
                None => return Ok(()),
            }
        }
    };
    write_boards(shared_dir, observation_date, complete, now)?;
    prune(shared_dir, &date, tick);
    Ok(())
}

fn write_part(shared_dir: &Path, date: &str, part: &Part) -> io::Result<()> {
    let path = part_path(shared_dir, date, part.tick, part.slice_index, part.slice_count);
    let folder = path.parent().expect("조각 파일은 폴더 안에 있다");
    fs::create_dir_all(folder)?;
    let temporary = folder.join(format!(".{}.tmp-{}", path.file_name().and_then(|name| name.to_str()).unwrap_or("part"), std::process::id()));
    fs::write(&temporary, serde_json::to_vec(part).map_err(io::Error::other)?)?;
    fs::rename(&temporary, &path)
}

fn read_all(shared_dir: &Path, date: &str, mine: Part, count: u32) -> io::Result<Option<Vec<Part>>> {
    let (tick, mine_index) = (mine.tick, mine.slice_index);
    let mut mine = Some(mine);
    let mut all = Vec::with_capacity(count as usize);
    for index in 0..count {
        if index == mine_index {
            all.extend(mine.take());
            continue;
        }
        match fs::read(part_path(shared_dir, date, tick, index, count)) {
            Ok(bytes) => all.push(serde_json::from_slice(&bytes).map_err(io::Error::other)?),
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error),
        }
    }
    Ok(Some(all))
}

fn write_boards(shared_dir: &Path, observation_date: KstDate, parts: Vec<Part>, now: KstTime) -> io::Result<()> {
    let mut by_venue: BTreeMap<VenueName, (u32, Vec<SnapshotRow>)> = BTreeMap::new();
    let mut indices = Vec::new();
    let mut sources: Vec<SourceKey> = Vec::new();
    let (mut as_of, mut closing) = (i64::MIN, false);
    for part in parts {
        as_of = as_of.max(part.finished_at);
        closing = part.closing;
        if !sources.iter().any(|source| source.key_name == part.key) {
            sources.push(SourceKey { key_name: part.key, broker: Broker::Kiwoom });
        }
        indices.extend(part.indices);
        for venue_part in part.venues {
            let (requested, rows) = by_venue.entry(venue_part.venue).or_default();
            *requested += venue_part.requested;
            rows.extend(venue_part.rows);
        }
    }
    indices.sort_by(|a, b| a.code.cmp(&b.code));
    let (requested_all, read_all): (u32, usize) = by_venue.values().fold((0, 0), |(requested, read), (venue_requested, rows)| (requested + venue_requested, read + rows.len()));
    if requested_all > 0 && read_all == 0 {
        return Err(io::Error::other(format!("모든 키의 응답에서 읽히는 행이 하나도 없습니다({requested_all}종목 요청). 이전 판을 둡니다")));
    }
    for (venue, (requested, mut stocks)) in by_venue {
        stocks.sort_by(|a, b| a.code.cmp(&b.code));
        let missing = requested.saturating_sub(stocks.len() as u32);
        let header = Header::new(venue.kind(), observation_date, as_of, now.unix(), sources.clone());
        write_snapshot(shared_dir, header, SnapshotBody { closing, requested, missing, stocks, indices: indices.clone() })?;
    }
    Ok(())
}

fn prune(shared_dir: &Path, date: &str, tick: i64) {
    remove_where(&parts_dir(shared_dir), |name| {
        let mut fields = name.split('.');
        let (part_date, part_tick) = (fields.next(), fields.next().and_then(|text| text.parse::<i64>().ok()));
        part_date != Some(date) || part_tick.is_some_and(|part_tick| part_tick < tick)
    });
    for kind in KINDS {
        remove_where(&shared_dir.join(kind.folder()), |name| name.strip_suffix(".json").is_some_and(|stem| stem.len() == 8 && stem.bytes().all(|byte| byte.is_ascii_digit()) && stem < date));
    }
}

fn remove_where(folder: &Path, stale: impl Fn(&str) -> bool) {
    let Ok(entries) = fs::read_dir(folder) else { return };
    for entry in entries.filter_map(Result::ok) {
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else { continue };
        if !name.starts_with('.')
            && stale(&name)
            && let Err(error) = fs::remove_file(entry.path())
        {
            tracing::warn!(path = %entry.path().display(), %error, "지난 공용 자료 파일을 지우지 못했습니다");
        }
    }
}
