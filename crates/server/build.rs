fn main() {
    if std::env::var_os("CARGO_FEATURE_BUNDLED_DUCKDB").is_none() {
        match std::env::var("CARGO_CFG_TARGET_OS").as_deref() {
            Ok("linux") => println!("cargo:rustc-link-arg=-Wl,-rpath,$ORIGIN:$ORIGIN/.."),
            Ok("macos") => println!("cargo:rustc-link-arg=-Wl,-rpath,@loader_path,-rpath,@loader_path/.."),
            _ => {}
        }
    }
}
