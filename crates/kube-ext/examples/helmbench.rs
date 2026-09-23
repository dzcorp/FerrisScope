//! Helm release decode / projection costs on a large synthetic release.
//!
//! `cargo run --release -p ferrisscope-kube-ext --example helmbench`

use std::collections::BTreeMap;
use std::fmt::Write as _;
use std::io::Write;
use std::time::{Duration, Instant};

use base64::Engine;
use ferrisscope_kube_ext::kinds::helm_releases::{
    decode_release, decode_release_summary, manifest_resources, project_detail, project_row,
    ReleaseIndex,
};
use flate2::write::GzEncoder;
use flate2::Compression;
use k8s_openapi::api::core::v1::Secret;
use k8s_openapi::ByteString;
use serde_json::{json, Value};

const TEMPLATES: usize = 300;
const DOCS: usize = 600;

fn big_release(version: i64) -> Value {
    let b64 = |s: &str| base64::engine::general_purpose::STANDARD.encode(s);
    let template = "{{- if .Values.enabled }}\n".repeat(120);
    let templates: Vec<Value> = (0..TEMPLATES)
        .map(|i| json!({ "name": format!("templates/t{i}.yaml"), "data": b64(&template) }))
        .collect();
    let env = "        - name: K\n          value: v\n".repeat(20);
    let mut manifest = String::new();
    for i in 0..DOCS {
        let _ = write!(
        manifest,
            "---\n# Source: big/templates/t{i}.yaml\napiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: web-{i}\n  labels:\n    app: web\nspec:\n  replicas: 2\n  template:\n    spec:\n      containers:\n      - name: c\n        image: nginx:1.25\n        env:\n{env}"
        );
    }
    let values: serde_json::Map<String, Value> = (0..2000)
        .map(|i| (format!("key{i}"), json!({ "enabled": true, "n": i })))
        .collect();
    json!({
        "name": "big", "namespace": "ns", "version": version,
        "info": { "status": "deployed", "last_deployed": "2026-01-01T00:00:00Z", "notes": "n".repeat(4096) },
        "chart": {
            "metadata": { "name": "big", "version": "1.2.3", "appVersion": "9", "home": "https://example.com" },
            "templates": templates,
            "values": values,
        },
        "config": values,
        "manifest": manifest,
        "hooks": (0..5).map(|i| json!({
            "name": format!("h{i}"), "kind": "Job", "events": ["pre-upgrade"],
            "last_run": { "phase": "Succeeded" },
            "manifest": format!("apiVersion: batch/v1\nkind: Job\nmetadata:\n  name: h{i}\n"),
        })).collect::<Vec<_>>(),
    })
}

fn secret(uid: usize, rel: &Value) -> Secret {
    let json = serde_json::to_vec(rel).expect("json");
    let mut gz = GzEncoder::new(Vec::new(), Compression::best());
    gz.write_all(&json).expect("gzip");
    let payload = base64::engine::general_purpose::STANDARD
        .encode(gz.finish().expect("gzip"))
        .into_bytes();
    let mut s = Secret::default();
    s.metadata.namespace = Some("ns".into());
    s.metadata.name = Some(format!("sh.helm.release.v1.big.v{uid}"));
    s.metadata.uid = Some(format!("uid-{uid}"));
    s.metadata.resource_version = Some(uid.to_string());
    s.data = Some(BTreeMap::from([("release".into(), ByteString(payload))]));
    s
}

fn time<T>(label: &str, iters: u32, mut f: impl FnMut() -> T) -> T {
    let mut out = f();
    let start = Instant::now();
    for _ in 0..iters {
        out = f();
    }
    let per = start.elapsed() / iters;
    println!("{label:<44} {:>9.3} ms", per.as_secs_f64() * 1e3);
    out
}

fn main() {
    let rel = big_release(10);
    let json_len = serde_json::to_vec(&rel).expect("json").len();
    let sec = secret(10, &rel);
    let secret_len = sec.data.as_ref().expect("data")["release"].0.len();
    println!(
        "release json {:.1} MiB, secret payload {:.1} KiB",
        json_len as f64 / 1048576.0,
        secret_len as f64 / 1024.0
    );

    let full = time("decode_release (full)", 20, || {
        decode_release(&sec).expect("decode")
    });
    let summary = time("decode_release_summary", 20, || {
        decode_release_summary(&sec).expect("decode")
    });
    time("project_row", 1000, || project_row(&summary));
    let manifest = full.manifest.clone().unwrap_or_default();
    time("manifest_resources (600 docs)", 20, || {
        manifest_resources(&manifest, "ns")
    });
    let history: Vec<_> = (1..=10).map(|_| summary.clone()).collect();
    let detail = time("project_detail (manifest + hooks parse)", 20, || {
        project_detail(&full, &history, true, None)
    });
    println!(
        "detail resources: {}, detail JSON {:.1} MiB",
        detail["resources"].as_array().map_or(0, Vec::len),
        serde_json::to_vec(&detail).expect("json").len() as f64 / 1048576.0
    );

    // Watcher path: 200 revision secrets, then a relist that replays them.
    let secrets: Vec<Secret> = (0..200)
        .map(|i| secret(i, &big_release(i as i64)))
        .collect();
    let mut idx: ReleaseIndex<Value> = ReleaseIndex::default();
    let start = Instant::now();
    for s in &secrets {
        let r = decode_release_summary(s).expect("decode");
        idx.upsert(
            s.metadata.uid.clone().expect("uid"),
            r.key(),
            r.version,
            s.metadata.resource_version.clone(),
            project_row(&r),
        );
    }
    let first: Duration = start.elapsed();
    let start = Instant::now();
    let skipped = secrets
        .iter()
        .filter(|s| {
            idx.is_current(
                s.metadata.uid.as_deref().expect("uid"),
                s.metadata.resource_version.as_deref(),
            )
        })
        .count();
    println!(
        "watcher: 200 secrets first sync {:.1} ms; relist {} unchanged skipped in {:.3} ms",
        first.as_secs_f64() * 1e3,
        skipped,
        start.elapsed().as_secs_f64() * 1e3
    );
    let row_bytes = serde_json::to_vec(idx.latest(&("ns".into(), "big".into())).expect("row"))
        .expect("json")
        .len();
    println!("watcher retains one projected row per revision (~{row_bytes} B JSON) instead of the {:.1} MiB release", json_len as f64 / 1048576.0);
}
