use std::time::Duration;

use domain::TimeOfDay;

const END_OF_DAY: TimeOfDay = match TimeOfDay::hms(20, 5, 0) {
    Some(time) => time,
    None => unreachable!(),
};

#[derive(Debug, Clone)]
pub struct Settings {
    pub token_spacing: Duration,
    pub heartbeat_timeout: Duration,
    pub restart_delays: Vec<Duration>,
    pub restart_limit: u32,
    pub shutdown_grace: Duration,
    pub housekeeping_every: Duration,
    pub end_at: Option<TimeOfDay>,
}

impl Default for Settings {
    fn default() -> Settings {
        Settings {
            token_spacing: Duration::from_secs(5),
            heartbeat_timeout: Duration::from_secs(15),
            restart_delays: [1, 2, 5, 10, 30].map(Duration::from_secs).to_vec(),
            restart_limit: 5,
            shutdown_grace: Duration::from_secs(10),
            housekeeping_every: Duration::from_secs(60),
            end_at: Some(END_OF_DAY),
        }
    }
}

impl Settings {
    pub fn restart_delay(&self, restarts_so_far: u32) -> Duration {
        self.restart_delays.get(restarts_so_far as usize).or(self.restart_delays.last()).copied().unwrap_or(Duration::ZERO)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn restart_delays_grow_and_keep_the_last_value() {
        let settings = Settings::default();
        let seconds: Vec<u64> = (0..8).map(|restarts| settings.restart_delay(restarts).as_secs()).collect();
        assert_eq!(seconds, [1, 2, 5, 10, 30, 30, 30, 30]);
    }
}
