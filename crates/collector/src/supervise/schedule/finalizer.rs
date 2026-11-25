use std::io;
use std::path::{Path, PathBuf};

use futures::future::BoxFuture;
use tokio::process::Command;

use super::settings::ScheduleSettings;

pub trait FinalizeRunner: Send + Sync {
    fn run(&self, arguments: Vec<String>) -> BoxFuture<'_, io::Result<i32>>;

    fn run_quotes_backfill(&self, _arguments: Vec<String>) -> BoxFuture<'_, io::Result<i32>> {
        Box::pin(async { Ok(0) })
    }

    fn priority_note(&self) -> Option<String> {
        None
    }
}

pub fn quotes_backfill_arguments(data_dir: &Path, shared_dir: &Path, date: u32, settings: &ScheduleSettings) -> Vec<String> {
    let mut arguments = [
        ("--data", data_dir.to_string_lossy().into_owned()),
        ("--date", date.to_string()),
        ("--threads", settings.finalize_threads.to_string()),
    ]
    .into_iter()
    .flat_map(|(name, value)| [name.to_owned(), value])
    .collect::<Vec<_>>();
    if shared_dir != data_dir.join("shared") {
        arguments.push("--shared".to_owned());
        arguments.push(shared_dir.to_string_lossy().into_owned());
    }
    arguments
}

pub fn finalize_arguments(data_dir: &Path, date: u32, settings: &ScheduleSettings) -> Vec<String> {
    let retention = &settings.retention;
    [
        ("--data", data_dir.to_string_lossy().into_owned()),
        ("--date", date.to_string()),
        ("--threads", settings.finalize_threads.to_string()),
        ("--keep-early", retention.early_keep.to_string()),
        ("--keep", retention.steady_keep.to_string()),
        ("--early-period", retention.early_period.to_string()),
    ]
    .into_iter()
    .flat_map(|(name, value)| [name.to_owned(), value])
    .chain(["--prune".to_owned()])
    .collect()
}

const PRIORITY_TOOLS: [(&str, &[&str]); 2] = [("nice", &["-n", "10"]), ("ionice", &["-c", "3"])];

pub struct ProcessFinalizeRunner {
    executable: PathBuf,
    prefix: Vec<String>,
    missing: Vec<&'static str>,
}

impl ProcessFinalizeRunner {
    pub fn new(executable: PathBuf) -> ProcessFinalizeRunner {
        let search_path = std::env::var_os("PATH").unwrap_or_default();
        let folders: Vec<PathBuf> = std::env::split_paths(&search_path).collect();
        let mut prefix = Vec::new();
        let mut missing = Vec::new();
        for (tool, tool_arguments) in PRIORITY_TOOLS {
            if folders.iter().any(|folder| is_executable(&folder.join(tool))) {
                prefix.push(tool.to_owned());
                prefix.extend(tool_arguments.iter().map(|argument| (*argument).to_owned()));
            } else {
                missing.push(tool);
            }
        }
        ProcessFinalizeRunner { executable, prefix, missing }
    }

    fn command(&self, arguments: &[String]) -> Command {
        self.subcommand(&["finalize"], arguments)
    }

    fn subcommand(&self, sub: &[&str], arguments: &[String]) -> Command {
        let mut words = self
            .prefix
            .iter()
            .cloned()
            .chain(std::iter::once(self.executable.to_string_lossy().into_owned()))
            .chain(sub.iter().map(|word| (*word).to_owned()));
        let program = words.next().expect("실행 파일 경로가 있다");
        let mut command = Command::new(program);
        command.args(words).args(arguments).kill_on_drop(true);
        command
    }
}

fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path).is_ok_and(|metadata| metadata.is_file() && metadata.permissions().mode() & 0o111 != 0)
}

impl FinalizeRunner for ProcessFinalizeRunner {
    fn run(&self, arguments: Vec<String>) -> BoxFuture<'_, io::Result<i32>> {
        Box::pin(async move {
            let status = self.command(&arguments).status().await?;
            Ok(status.code().unwrap_or(-1))
        })
    }

    fn run_quotes_backfill(&self, arguments: Vec<String>) -> BoxFuture<'_, io::Result<i32>> {
        Box::pin(async move {
            let status = self.subcommand(&["quotes", "backfill"], &arguments).status().await?;
            Ok(status.code().unwrap_or(-1))
        })
    }

    fn priority_note(&self) -> Option<String> {
        (!self.missing.is_empty()).then(|| format!("{}가 없어 낮은 우선순위 없이 finalize를 돌립니다", self.missing.join("·")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn arguments_carry_the_day_threads_and_retention() {
        let settings = ScheduleSettings { finalize_threads: 3, ..ScheduleSettings::default() };
        let arguments = finalize_arguments(Path::new("/data/hoga"), 20261118, &settings);
        assert_eq!(
            arguments,
            ["--data", "/data/hoga", "--date", "20261118", "--threads", "3", "--keep-early", "7", "--keep", "1", "--early-period", "10", "--prune"]
        );
    }

    #[test]
    fn the_real_runner_puts_nice_and_ionice_in_front_of_the_executable() {
        let runner = ProcessFinalizeRunner { executable: PathBuf::from("/bin/collector"), prefix: ["nice", "-n", "10", "ionice", "-c", "3"].map(str::to_owned).to_vec(), missing: Vec::new() };
        let command = runner.command(&["--date".to_owned(), "20261118".to_owned()]);
        let std = command.as_std();
        let words: Vec<String> = std::iter::once(std.get_program()).chain(std.get_args()).map(|word| word.to_string_lossy().into_owned()).collect();
        assert_eq!(words, ["nice", "-n", "10", "ionice", "-c", "3", "/bin/collector", "finalize", "--date", "20261118"]);
        assert_eq!(runner.priority_note(), None);
    }

    #[test]
    fn a_missing_tool_is_reported_and_left_out_of_the_command() {
        let runner = ProcessFinalizeRunner { executable: PathBuf::from("/bin/collector"), prefix: Vec::new(), missing: vec!["nice", "ionice"] };
        let command = runner.command(&[]);
        assert_eq!(command.as_std().get_program(), "/bin/collector");
        assert!(runner.priority_note().unwrap().contains("nice·ionice"));
    }

    #[test]
    fn quotes_backfill_arguments_include_shared_only_when_separate() {
        let settings = ScheduleSettings { finalize_threads: 3, ..ScheduleSettings::default() };
        let default_args = quotes_backfill_arguments(Path::new("/data/hoga"), Path::new("/data/hoga/shared"), 20261118, &settings);
        assert_eq!(default_args, ["--data", "/data/hoga", "--date", "20261118", "--threads", "3"]);
        let separate_args = quotes_backfill_arguments(Path::new("/data/hoga"), Path::new("/srv/shared"), 20261118, &settings);
        assert_eq!(separate_args, ["--data", "/data/hoga", "--date", "20261118", "--threads", "3", "--shared", "/srv/shared"]);
        let runner = ProcessFinalizeRunner { executable: PathBuf::from("/bin/collector"), prefix: ["nice", "-n", "10"].map(str::to_owned).to_vec(), missing: Vec::new() };
        let command = runner.subcommand(&["quotes", "backfill"], &default_args);
        let std = command.as_std();
        let words: Vec<String> = std::iter::once(std.get_program()).chain(std.get_args()).map(|word| word.to_string_lossy().into_owned()).collect();
        assert_eq!(words, ["nice", "-n", "10", "/bin/collector", "quotes", "backfill", "--data", "/data/hoga", "--date", "20261118", "--threads", "3"]);
    }
}
