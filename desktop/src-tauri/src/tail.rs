use std::collections::VecDeque;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::sync::{Arc, Mutex};

const KEPT_LINES: usize = 40;
const LINE_CHARACTERS: usize = 400;

#[derive(Clone, Default)]
pub struct LogTail(Arc<Mutex<VecDeque<String>>>);

impl LogTail {
    pub fn push(&self, line: &str) {
        let mut lines = self.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if lines.len() == KEPT_LINES {
            lines.pop_front();
        }
        lines.push_back(line.chars().take(LINE_CHARACTERS).collect());
    }

    pub fn last(&self, count: usize) -> Vec<String> {
        let lines = self.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        lines.iter().skip(lines.len().saturating_sub(count)).cloned().collect()
    }

    pub fn drain_in_background(&self, reader: impl Read + Send + 'static) {
        let tail = self.clone();
        std::thread::spawn(move || {
            let mut reader = BufReader::new(reader);
            let mut raw = Vec::new();
            loop {
                raw.clear();
                match reader.read_until(b'\n', &mut raw) {
                    Ok(0) | Err(_) => return,
                    Ok(_) => {
                        let line = String::from_utf8_lossy(&raw);
                        let line = line.trim_end();
                        let _ = writeln!(io::stderr(), "[engine] {line}");
                        tail.push(line);
                    }
                }
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_most_recent_lines_are_kept() {
        let tail = LogTail::default();
        for number in 0..KEPT_LINES + 5 {
            tail.push(&format!("line {number}"));
        }
        assert_eq!(tail.last(2), vec!["line 43".to_owned(), "line 44".to_owned()]);
        assert_eq!(tail.last(1000).len(), KEPT_LINES);
    }

    #[test]
    fn a_long_line_is_cut() {
        let tail = LogTail::default();
        tail.push(&"가".repeat(LINE_CHARACTERS * 2));
        assert_eq!(tail.last(1)[0].chars().count(), LINE_CHARACTERS);
    }

    #[test]
    fn the_background_reader_drains_the_stream_to_the_end() {
        let tail = LogTail::default();
        tail.drain_in_background(std::io::Cursor::new(b"first\nsecond\r\nthird".to_vec()));
        for _ in 0..100 {
            if tail.last(10).len() == 3 {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        assert_eq!(tail.last(10), vec!["first".to_owned(), "second".to_owned(), "third".to_owned()]);
    }
}
