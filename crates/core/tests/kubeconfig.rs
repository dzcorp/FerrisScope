//! Tests for kubeconfig parsing, source resolution, and edit operations.
//!
//! These run without Docker — they write synthetic kubeconfigs into a
//! tempdir, exercise the public API, and verify the on-disk YAML after
//! mutating operations.

use std::fmt::Write as _;
use std::path::PathBuf;

use ferrisscope_core::kubeconfig::{
    context_name_from_id, delete_context_in_file, list_contexts, resolve_path_for,
    set_current_context_in_file, source_path_for, DEFAULT_SOURCE_ID,
};
use ferrisscope_core::sources::{KubeconfigSource, SourceKind, SourcesFile};
use pretty_assertions::assert_eq;
use tempfile::TempDir;

/// Minimal valid kubeconfig YAML with the given contexts. Each context gets
/// its own cluster + user entry so prune/dedup logic has something to chew
/// on.
fn write_kubeconfig(dir: &std::path::Path, filename: &str, contexts: &[&str]) -> PathBuf {
    let mut clusters = String::new();
    let mut users = String::new();
    let mut ctxs = String::new();
    for c in contexts {
        let _ = write!(
            clusters,
            "- name: cluster-{c}\n  cluster:\n    server: https://example.invalid:6443\n    insecure-skip-tls-verify: true\n"
        );
        let _ = write!(users, "- name: user-{c}\n  user:\n    token: t-{c}\n");
        let _ = write!(
            ctxs,
            "- name: {c}\n  context:\n    cluster: cluster-{c}\n    user: user-{c}\n"
        );
    }
    let yaml = format!(
        "apiVersion: v1\nkind: Config\ncurrent-context: {}\nclusters:\n{}users:\n{}contexts:\n{}",
        contexts.first().copied().unwrap_or(""),
        clusters,
        users,
        ctxs,
    );
    let path = dir.join(filename);
    std::fs::write(&path, yaml).expect("write fixture kubeconfig");
    path
}

fn empty_sources() -> SourcesFile {
    // default_disabled=true keeps the system default kubeconfig out of
    // results so test outcomes don't depend on the developer's machine.
    SourcesFile {
        default_disabled: true,
        last_picked_dir: None,
        sources: vec![],
    }
}

#[test]
fn list_contexts_from_single_file_source() {
    let tmp = TempDir::new().unwrap();
    let path = write_kubeconfig(tmp.path(), "config.yaml", &["alpha", "beta"]);

    let mut file = empty_sources();
    file.sources.push(KubeconfigSource {
        id: "src1".into(),
        path: path.clone(),
        kind: SourceKind::File,
        group_override: Some("Lab".into()),
        enabled: true,
        ssh: None,
    });

    let ctxs = list_contexts(&file).unwrap();
    let names: Vec<_> = ctxs.iter().map(|c| c.name.as_str()).collect();
    assert_eq!(names, vec!["alpha", "beta"]);
    for c in &ctxs {
        assert_eq!(c.group, "Lab");
        assert_eq!(c.source_id, "src1");
        assert_eq!(c.source_path.as_deref(), Some(path.as_path()));
        // Non-default sources never claim "current" — only the system
        // default is allowed to highlight a tile.
        assert!(!c.is_current, "user source must not propagate is_current");
    }
}

#[test]
fn list_contexts_disabled_source_is_skipped() {
    let tmp = TempDir::new().unwrap();
    let path = write_kubeconfig(tmp.path(), "config.yaml", &["only"]);

    let mut file = empty_sources();
    file.sources.push(KubeconfigSource {
        id: "src1".into(),
        path,
        kind: SourceKind::File,
        group_override: None,
        enabled: false,
        ssh: None,
    });

    let ctxs = list_contexts(&file).unwrap();
    assert!(
        ctxs.is_empty(),
        "disabled sources must not contribute contexts"
    );
}

#[test]
fn list_contexts_folder_scan_skips_non_kubeconfig_files() {
    let tmp = TempDir::new().unwrap();
    write_kubeconfig(tmp.path(), "team-a.yaml", &["dev-a", "prod-a"]);
    write_kubeconfig(tmp.path(), "team-b.yaml", &["dev-b"]);
    // A YAML that is NOT a kubeconfig — must be filtered out by the header
    // sniff. (Helm values, for instance.)
    std::fs::write(
        tmp.path().join("values.yaml"),
        "apiVersion: helm.values\nimage:\n  tag: latest\n",
    )
    .unwrap();
    // A binary blob with a kubeconfig-ish extension — must be rejected.
    std::fs::write(tmp.path().join("garbage.yml"), [0u8, 1, 2, 3, 4, 5]).unwrap();
    // A dotfile — must be skipped without even being read.
    std::fs::write(tmp.path().join(".hidden.yaml"), "anything").unwrap();

    let mut file = empty_sources();
    file.sources.push(KubeconfigSource {
        id: "team".into(),
        path: tmp.path().to_path_buf(),
        kind: SourceKind::Folder,
        group_override: None,
        enabled: true,
        ssh: None,
    });

    let ctxs = list_contexts(&file).unwrap();
    let mut names: Vec<_> = ctxs.iter().map(|c| c.name.clone()).collect();
    names.sort();
    assert_eq!(names, vec!["dev-a", "dev-b", "prod-a"]);

    // Folder sources tag each child with `<src_id>/<filename>` so duplicate
    // context names across files in the same folder stay distinct.
    let unique_source_ids: std::collections::HashSet<_> =
        ctxs.iter().map(|c| c.source_id.clone()).collect();
    assert_eq!(unique_source_ids.len(), 2);
    for sid in &unique_source_ids {
        assert!(sid.starts_with("team/"), "got source_id {sid}");
    }
}

#[test]
fn list_contexts_dedups_by_id() {
    let tmp = TempDir::new().unwrap();
    let p = write_kubeconfig(tmp.path(), "c.yaml", &["dup"]);
    let mut file = empty_sources();
    // Same source registered twice — same id → same composite, dedup.
    file.sources.push(KubeconfigSource {
        id: "src".into(),
        path: p.clone(),
        kind: SourceKind::File,
        group_override: None,
        enabled: true,
        ssh: None,
    });
    file.sources.push(KubeconfigSource {
        id: "src".into(),
        path: p,
        kind: SourceKind::File,
        group_override: None,
        enabled: true,
        ssh: None,
    });
    let ctxs = list_contexts(&file).unwrap();
    assert_eq!(ctxs.len(), 1);
}

#[test]
fn source_path_for_resolves_file_and_folder_children() {
    let tmp = TempDir::new().unwrap();
    let file_path = write_kubeconfig(tmp.path(), "team-a.yaml", &["a"]);

    let mut file = empty_sources();
    file.sources.push(KubeconfigSource {
        id: "f".into(),
        path: file_path.clone(),
        kind: SourceKind::File,
        group_override: None,
        enabled: true,
        ssh: None,
    });
    file.sources.push(KubeconfigSource {
        id: "folder".into(),
        path: tmp.path().to_path_buf(),
        kind: SourceKind::Folder,
        group_override: None,
        enabled: true,
        ssh: None,
    });

    // File source: id is "<src>::<ctx>"; we recover the original path.
    let id = "f::a";
    assert_eq!(source_path_for(id, &file), Some(file_path.clone()));
    assert_eq!(context_name_from_id(id), "a");

    // Folder source: id is "<src>/<filename>::<ctx>"; we recover
    // <folder_path>/<filename>.
    let folder_id = "folder/team-a.yaml::a";
    assert_eq!(
        source_path_for(folder_id, &file),
        Some(tmp.path().join("team-a.yaml"))
    );

    // Default source: source_path_for returns None (kube-rs resolves it),
    // but resolve_path_for falls back to the system default.
    let default_id = format!("{DEFAULT_SOURCE_ID}::cluster-x");
    assert!(source_path_for(&default_id, &file).is_none());
    // resolve_path_for may or may not return a path depending on
    // HOME / KUBECONFIG; just verify it doesn't panic.
    let _ = resolve_path_for(&default_id, &file);
}

#[test]
fn delete_context_in_file_removes_context_and_orphan_cluster_user() {
    let tmp = TempDir::new().unwrap();
    let path = write_kubeconfig(tmp.path(), "config.yaml", &["keep", "drop"]);

    delete_context_in_file(&path, "drop").unwrap();

    let raw = std::fs::read_to_string(&path).unwrap();
    let parsed: serde_yaml::Value = serde_yaml::from_str(&raw).unwrap();
    let map = parsed.as_mapping().unwrap();
    let names: Vec<&str> = map
        .get(serde_yaml::Value::String("contexts".into()))
        .and_then(|v| v.as_sequence())
        .unwrap()
        .iter()
        .filter_map(|e| e.get("name").and_then(|n| n.as_str()))
        .collect();
    assert_eq!(names, vec!["keep"]);

    // Orphan cluster + user (cluster-drop / user-drop) were pruned.
    let cluster_names: Vec<&str> = map
        .get(serde_yaml::Value::String("clusters".into()))
        .and_then(|v| v.as_sequence())
        .unwrap()
        .iter()
        .filter_map(|e| e.get("name").and_then(|n| n.as_str()))
        .collect();
    assert_eq!(cluster_names, vec!["cluster-keep"]);
    let user_names: Vec<&str> = map
        .get(serde_yaml::Value::String("users".into()))
        .and_then(|v| v.as_sequence())
        .unwrap()
        .iter()
        .filter_map(|e| e.get("name").and_then(|n| n.as_str()))
        .collect();
    assert_eq!(user_names, vec!["user-keep"]);
}

#[test]
fn delete_context_in_file_keeps_shared_cluster_or_user() {
    let tmp = TempDir::new().unwrap();
    let path = tmp.path().join("config.yaml");
    // Two contexts pointing at the same cluster + user — removing one must
    // leave the cluster/user entries untouched because they're still in use.
    let yaml = r"apiVersion: v1
kind: Config
current-context: a
clusters:
- name: shared
  cluster:
    server: https://example.invalid:6443
users:
- name: shared
  user:
    token: t
contexts:
- name: a
  context:
    cluster: shared
    user: shared
- name: b
  context:
    cluster: shared
    user: shared
";
    std::fs::write(&path, yaml).unwrap();

    delete_context_in_file(&path, "a").unwrap();

    let raw = std::fs::read_to_string(&path).unwrap();
    assert!(raw.contains("name: shared"), "shared cluster pruned: {raw}");
    assert!(raw.contains("name: b"), "context b removed: {raw}");
    assert!(!raw.contains("name: a\n"), "context a still present: {raw}");
}

#[test]
fn delete_context_in_file_clears_current_context_when_it_matches() {
    let tmp = TempDir::new().unwrap();
    let path = write_kubeconfig(tmp.path(), "config.yaml", &["alpha", "beta"]);
    // current-context was set to "alpha" by write_kubeconfig (first ctx).
    delete_context_in_file(&path, "alpha").unwrap();
    let raw = std::fs::read_to_string(&path).unwrap();
    let parsed: serde_yaml::Value = serde_yaml::from_str(&raw).unwrap();
    let cc = parsed
        .as_mapping()
        .unwrap()
        .get(serde_yaml::Value::String("current-context".into()))
        .and_then(|v| v.as_str())
        .unwrap();
    assert_eq!(cc, "", "current-context should be cleared, got {cc:?}");
}

#[test]
fn delete_context_in_file_refuses_emptying() {
    let tmp = TempDir::new().unwrap();
    let path = write_kubeconfig(tmp.path(), "config.yaml", &["only"]);
    let err = delete_context_in_file(&path, "only").unwrap_err();
    let msg = err.to_string();
    assert!(
        msg.contains("delete the file instead"),
        "expected guidance to delete the file, got: {msg}"
    );
    // File on disk must be unchanged (no atomic rename happened).
    let raw = std::fs::read_to_string(&path).unwrap();
    assert!(raw.contains("name: only"));
}

#[test]
fn delete_context_in_file_errors_on_missing_context() {
    let tmp = TempDir::new().unwrap();
    let path = write_kubeconfig(tmp.path(), "config.yaml", &["a", "b"]);
    let err = delete_context_in_file(&path, "ghost").unwrap_err();
    assert!(err.to_string().contains("ghost"));
}

#[test]
fn set_current_context_in_file_updates_pointer() {
    let tmp = TempDir::new().unwrap();
    let path = write_kubeconfig(tmp.path(), "config.yaml", &["a", "b"]);
    set_current_context_in_file(&path, "b").unwrap();
    let raw = std::fs::read_to_string(&path).unwrap();
    let parsed: serde_yaml::Value = serde_yaml::from_str(&raw).unwrap();
    let cc = parsed
        .as_mapping()
        .unwrap()
        .get(serde_yaml::Value::String("current-context".into()))
        .and_then(|v| v.as_str())
        .unwrap();
    assert_eq!(cc, "b");
}

#[test]
fn set_current_context_in_file_rejects_unknown_context() {
    let tmp = TempDir::new().unwrap();
    let path = write_kubeconfig(tmp.path(), "config.yaml", &["a"]);
    let err = set_current_context_in_file(&path, "ghost").unwrap_err();
    assert!(err.to_string().contains("ghost"));
}
