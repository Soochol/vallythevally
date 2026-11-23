use std::path::{Path, PathBuf};

pub fn first_existing(candidates: Vec<Option<PathBuf>>, exists: impl Fn(&Path) -> bool) -> Result<PathBuf, Vec<PathBuf>> {
    let candidates: Vec<PathBuf> = candidates.into_iter().flatten().collect();
    candidates.iter().find(|path| exists(path)).cloned().ok_or(candidates)
}

pub fn engine_file_name() -> String {
    format!("vally-server{}", std::env::consts::EXE_SUFFIX)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_first_existing_candidate_wins_and_missing_slots_are_skipped() {
        let candidates = vec![None, Some("/a".into()), Some("/b".into()), Some("/c".into())];
        let found = first_existing(candidates, |path| path != Path::new("/a"));
        assert_eq!(found, Ok(PathBuf::from("/b")));
    }

    #[test]
    fn when_nothing_exists_the_searched_paths_come_back_for_the_failure_message() {
        let found = first_existing(vec![Some("/a".into()), None, Some("/b".into())], |_| false);
        assert_eq!(found, Err(vec![PathBuf::from("/a"), PathBuf::from("/b")]));
    }
}
