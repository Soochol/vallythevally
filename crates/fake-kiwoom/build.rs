use std::{env, fs, path::PathBuf};

fn main() {
    let root = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").expect("manifest directory"))
        .join("../server/tests/fixtures/kiwoom");
    println!("cargo:rerun-if-changed={}", root.display());
    let mut files: Vec<_> = fs::read_dir(&root).expect("fixture directory")
        .map(|entry| entry.expect("fixture entry").path())
        .filter(|path| path.extension().is_some_and(|extension| extension == "json"))
        .collect();
    files.sort();
    let entries: Vec<_> = files.iter().map(|path| {
        let name = path.file_stem().expect("fixture name").to_str().expect("UTF-8 fixture name");
        format!("({name:?}, include_str!({path:?}))")
    }).collect();
    let output = format!("const FIXTURES: &[(&str, &str)] = &[{}];", entries.join(","));
    let out = PathBuf::from(env::var_os("OUT_DIR").expect("output directory"));
    fs::write(out.join("fixtures.rs"), output).expect("write embedded fixtures");
}
