//! cargo run --release -p ferrisscope-kube-ext --example objectstatusbench
use std::{error::Error, hint::black_box, io::Write, time::Instant};

use ferrisscope_kube_ext::object_status::{
    index_rows, normalize, Batch, CacheView, KeySet, ObjectRef,
};
use ferrisscope_kube_ext::{NsScope, RowJson};
use serde_json::json;

const ITERS: u32 = 50;

fn pod_row(i: usize) -> serde_json::Value {
    json!({
        "uid": format!("uid-{i}"), "namespace": format!("ns-{}", i % 20), "name": format!("pod-{i}"),
        "phase": "Running", "ready": "2/2", "restarts": 0, "cpu": null, "mem": null,
        "node": format!("node-{}", i % 50), "creation_timestamp": "2026-09-01T00:00:00Z",
        "container_states": [
            {"name":"app","kind":"main","image":"registry.example/app:1.2.3","state":"Running","reason":null,"ready":true,"restart_count":0},
            {"name":"proxy","kind":"sidecar","image":"registry.example/proxy:1.0","state":"Running","reason":null,"ready":true,"restart_count":0}
        ],
        "__labels": {"app": format!("app-{}", i % 100), "tier": "web"}
    })
}

fn main() -> Result<(), Box<dyn Error>> {
    let mut out = std::io::stdout().lock();
    for (cached_rows, refs_n) in [(5000usize, 2000usize), (20000, 2000)] {
        let rows: Vec<RowJson> = (0..cached_rows)
            .map(|i| RowJson::from_value(&pod_row(i)))
            .collect::<Result<_, _>>()?;
        let refs: Vec<ObjectRef> = (0..refs_n)
            .map(|i| ObjectRef {
                group: String::new(),
                kind: "Pod".into(),
                namespace: Some(format!("ns-{}", (i * 7) % 20)),
                name: format!("pod-{}", i * 7),
            })
            .collect();
        let views = vec![CacheView {
            kind_id: "pods".into(),
            scope: NsScope::All,
            rows,
        }];

        let t = Instant::now();
        for _ in 0..ITERS {
            black_box(index_rows(&views[0].rows, &KeySet::default(), true));
        }
        writeln!(
            out,
            "key scan only: {cached_rows} rows = {:.2} ms",
            (t.elapsed() / ITERS).as_secs_f64() * 1e3
        )?;

        let t = Instant::now();
        for _ in 0..ITERS {
            let mut b = Batch::new(black_box(refs.clone()));
            b.apply_cache(black_box(&views));
            black_box(b.finish());
        }
        let per = t.elapsed() / ITERS;
        writeln!(
            out,
            "cache resolve: {refs_n} refs over {cached_rows} rows = {:.2} ms/call",
            per.as_secs_f64() * 1e3
        )?;
    }

    let rows: Vec<serde_json::Value> = (0..2000).map(pod_row).collect();
    let t = Instant::now();
    for _ in 0..ITERS {
        for r in &rows {
            black_box(normalize("pods", black_box(r)));
        }
    }
    writeln!(
        out,
        "normalize: 2000 pod rows = {:.1} us/call",
        (t.elapsed() / ITERS).as_secs_f64() * 1e6
    )?;
    Ok(())
}
