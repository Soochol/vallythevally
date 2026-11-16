#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GapInterval {
    pub from_ms: u32,
    pub to_ms: u32,
}

impl GapInterval {
    fn new(from_ms: u32, to_ms: u32) -> GapInterval {
        GapInterval { from_ms, to_ms: to_ms.max(from_ms) }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LineEvent {
    Other,
    Live,
    Down,
}

#[derive(Debug, Default)]
pub struct GapTracker {
    previous_line_ms: Option<u32>,
    down_since: Option<u32>,
    gaps: Vec<GapInterval>,
}

impl GapTracker {
    pub fn record(&mut self, line_ms: u32, event: LineEvent) {
        match event {
            LineEvent::Other => {}
            LineEvent::Down => {
                self.down_since.get_or_insert(line_ms);
            }
            LineEvent::Live => {
                let gap_start = self.down_since.take().or(self.previous_line_ms);
                if let Some(from_ms) = gap_start {
                    self.gaps.push(GapInterval::new(from_ms, line_ms));
                }
            }
        }
        self.previous_line_ms = Some(line_ms);
    }

    pub fn finish(mut self) -> Vec<GapInterval> {
        if let Some(from_ms) = self.down_since.take() {
            let last_line_ms = self.previous_line_ms.unwrap_or(from_ms);
            self.gaps.push(GapInterval::new(from_ms, last_line_ms));
        }
        self.gaps
    }
}

pub fn gaps_in_span(gaps: &[GapInterval], span_start_ms: u32, span_end_ms: u32) -> Vec<GapInterval> {
    gaps.iter()
        .filter(|gap| {
            let overlaps = gap.from_ms < span_end_ms && gap.to_ms > span_start_ms;
            let instant_inside = gap.from_ms == gap.to_ms && (span_start_ms..span_end_ms).contains(&gap.from_ms);
            overlaps || instant_inside
        })
        .map(|gap| GapInterval {
            from_ms: gap.from_ms.max(span_start_ms),
            to_ms: gap.to_ms.min(span_end_ms),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tracked(lines: &[(u32, LineEvent)]) -> Vec<GapInterval> {
        let mut tracker = GapTracker::default();
        for &(line_ms, event) in lines {
            tracker.record(line_ms, event);
        }
        tracker.finish()
    }

    fn gap(from_ms: u32, to_ms: u32) -> GapInterval {
        GapInterval { from_ms, to_ms }
    }

    #[test]
    fn down_then_live_is_a_gap() {
        let gaps = tracked(&[(10, LineEvent::Live), (20, LineEvent::Other), (30, LineEvent::Down), (50, LineEvent::Live)]);
        assert_eq!(gaps, vec![gap(30, 50)]);
    }

    #[test]
    fn live_without_down_starts_at_the_previous_line() {
        let gaps = tracked(&[(10, LineEvent::Other), (25, LineEvent::Other), (60, LineEvent::Live)]);
        assert_eq!(gaps, vec![gap(25, 60)]);
    }

    #[test]
    fn first_line_live_is_not_a_gap() {
        assert_eq!(tracked(&[(10, LineEvent::Live), (20, LineEvent::Other)]), vec![]);
    }

    #[test]
    fn open_gap_ends_at_the_last_line() {
        let gaps = tracked(&[(10, LineEvent::Live), (30, LineEvent::Down), (45, LineEvent::Other)]);
        assert_eq!(gaps, vec![gap(30, 45)]);
    }

    #[test]
    fn second_down_keeps_the_first_start() {
        let gaps = tracked(&[(10, LineEvent::Down), (20, LineEvent::Down), (30, LineEvent::Live)]);
        assert_eq!(gaps, vec![gap(10, 30)]);
    }

    #[test]
    fn clipping_splits_a_gap_across_spans() {
        let gaps = [gap(250_000, 700_000)];
        assert_eq!(gaps_in_span(&gaps, 0, 300_000), vec![gap(250_000, 300_000)]);
        assert_eq!(gaps_in_span(&gaps, 300_000, 600_000), vec![gap(300_000, 600_000)]);
        assert_eq!(gaps_in_span(&gaps, 600_000, 900_000), vec![gap(600_000, 700_000)]);
        assert_eq!(gaps_in_span(&gaps, 900_000, 1_200_000), vec![]);
    }

    #[test]
    fn a_gap_ending_on_a_boundary_stays_in_the_earlier_span() {
        let gaps = [gap(100_000, 300_000)];
        assert_eq!(gaps_in_span(&gaps, 300_000, 600_000), vec![]);
        assert_eq!(gaps_in_span(&gaps, 0, 300_000), vec![gap(100_000, 300_000)]);
    }

    #[test]
    fn an_instant_gap_belongs_to_the_span_holding_it() {
        let gaps = [gap(300_000, 300_000)];
        assert_eq!(gaps_in_span(&gaps, 0, 300_000), vec![]);
        assert_eq!(gaps_in_span(&gaps, 300_000, 600_000), vec![gap(300_000, 300_000)]);
    }
}
