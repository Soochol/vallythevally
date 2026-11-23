#[cfg(test)]
mod tests {
    const GENERATED_PERMISSIONS: &str = concat!(env!("OUT_DIR"), "/acl-manifests.json");
    const GENERATED_CAPABILITIES: &str = concat!(env!("OUT_DIR"), "/capabilities.json");
    use std::fs;
    use std::path::Path;

    fn source(relative: &str) -> std::path::PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join(relative)
    }

    #[cfg(not(feature = "bench"))]
    #[test]
    fn the_default_build_has_no_measurement_command_in_its_permissions_or_capabilities() {
        let permissions = fs::read_to_string(GENERATED_PERMISSIONS).unwrap();
        let capabilities = fs::read_to_string(GENERATED_CAPABILITIES).unwrap();
        assert!(!permissions.contains("bench"), "기본 빌드가 만든 권한 목록에 측정 명령이 있습니다");
        assert!(!capabilities.contains("bench"), "기본 빌드의 capabilities에 측정 권한이 있습니다");
    }

    #[cfg(feature = "bench")]
    #[test]
    fn the_bench_build_declares_the_command_permission_but_no_build_time_capability_grants_it() {
        assert!(fs::read_to_string(GENERATED_PERMISSIONS).unwrap().contains("allow-bench-stream"));
        assert!(!fs::read_to_string(GENERATED_CAPABILITIES).unwrap().contains("bench"));
    }

    #[test]
    fn no_capability_file_or_window_config_in_the_source_tree_names_the_measurement() {
        for config in ["tauri.conf.json", "tauri.bundle.conf.json"] {
            assert!(!fs::read_to_string(source(config)).unwrap().contains("bench"), "{config}");
        }
        if let Ok(folder) = fs::read_dir(source("capabilities")) {
            for file in folder.flatten() {
                assert!(!fs::read_to_string(file.path()).unwrap().contains("bench"), "{}", file.path().display());
            }
        }
    }

    #[test]
    fn the_runtime_capability_reaches_only_the_loopback_origin_and_only_the_measurement_command() {
        let capability: serde_json::Value = serde_json::from_str(include_str!("../../bench/capability.json")).unwrap();
        assert_eq!(capability["remote"]["urls"], serde_json::json!(["http://127.0.0.1:*/*"]));
        assert_eq!(capability["permissions"], serde_json::json!(["allow-bench-stream"]));
    }
}
