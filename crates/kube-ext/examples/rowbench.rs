//! Hot-path benchmark for the watcher's row representation.
//!
//! ```text
//! cargo run --release -p ferrisscope-kube-ext --example rowbench
//! cargo run --release -p ferrisscope-kube-ext --example rowbench -- --residency
//! ```
//!
//! This is the measurement behind caching rows pre-serialised
//! (`RowJson`) rather than as a live `serde_json::Value` tree — see the
//! module docs on `watcher.rs`. It covers the four places a row is
//! touched:
//!
//! 1. the per-apply critical section in the watcher task,
//! 2. `ResourceWatcher::snapshot()` (runs on every `subscribe_resource`),
//! 3. the `MAX_EMIT_DELTAS`-sized batch the forwarder hands to `app.emit`,
//! 4. the blob the search-index writer stores.
//!
//! Deliberately dependency-free (no criterion): a fixed iteration count
//! with a warm-up, printing ns/op. Absolute numbers move with the machine;
//! the ratios are the point.

use std::collections::HashMap;
use std::time::Instant;

use ferrisscope_kube_ext::{ResourceDelta, RowJson};
use serde_json::{json, Value};

// -------------------------------------------------------------- residency

/// Resident-set size in bytes, or `None` where we can't read it.
///
/// The obvious instrument would be a counting `GlobalAlloc`, but the
/// workspace `forbid(unsafe_code)`s and examples inherit that — so we read
/// the OS's number instead. It's coarser: page-granular, and it counts
/// allocator slack the process hasn't handed back. Expect it to overstate
/// both shapes (~6.1 KiB/row vs an exact 4.7 KiB for `Value`, ~1.7 KiB vs
/// 0.9 KiB for `RowJson`) and so to understate the ratio — 3.6× here
/// against 5.1× when counted per-allocation. The direction is the point.
fn rss() -> Option<usize> {
    if cfg!(target_os = "linux") {
        let statm = std::fs::read_to_string("/proc/self/statm").ok()?;
        Some(statm.split_whitespace().nth(1)?.parse::<usize>().ok()? * 4096)
    } else {
        None
    }
}

// ---------------------------------------------------------------- fixtures

/// A projected Pod row in the shape `kinds::pods::project` produces, after
/// the watcher has injected `uid` and `__labels`: two containers, five
/// labels. Roughly the median object on a real cluster.
fn pod_row(i: usize) -> Value {
    json!({
        "uid": format!("11111111-2222-3333-4444-{i:012}"),
        "namespace": "kube-system",
        "name": format!("coredns-76f75df574-{i:05}"),
        "phase": "Running",
        "ready": "2/2",
        "restarts": 0,
        "cpu": Value::Null,
        "mem": Value::Null,
        "node": format!("ip-10-0-{}-{}.eu-central-1.compute.internal", i % 250, i % 99),
        "creation_timestamp": "2026-07-20T11:04:33Z",
        "containers": ["coredns", "istio-proxy"],
        "container_states": [
            {
                "name": "coredns", "kind": "main",
                "image": "registry.k8s.io/coredns/coredns:v1.11.1",
                "state": "running", "reason": Value::Null,
                "ready": true, "restarts": 0
            },
            {
                "name": "istio-proxy", "kind": "sidecar",
                "image": "docker.io/istio/proxyv2:1.22.1",
                "state": "running", "reason": Value::Null,
                "ready": true, "restarts": 0
            }
        ],
        "__labels": {
            "app.kubernetes.io/name": "coredns",
            "app.kubernetes.io/instance": "coredns",
            "pod-template-hash": "76f75df574",
            "k8s-app": "kube-dns",
            "security.istio.io/tlsMode": "istio"
        }
    })
}

fn uid_of(i: usize) -> String {
    format!("11111111-2222-3333-4444-{i:012}")
}

fn raw(v: &Value) -> RowJson {
    RowJson::from_value(v).expect("fixture serialises")
}

/// The pre-`RowJson` delta shape, kept purely as the baseline to measure
/// against. Mirrors what `ResourceDelta` looked like when the watcher
/// cached rows as `Value`.
#[derive(serde::Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
enum LegacyDelta {
    Upsert { row: Value },
}

// ----------------------------------------------------------------- harness

fn bench<F: FnMut()>(name: &str, iters: usize, mut f: F) {
    for _ in 0..(iters / 8).max(1) {
        f();
    }
    let t = Instant::now();
    for _ in 0..iters {
        f();
    }
    let per = t.elapsed().as_secs_f64() * 1e9 / iters as f64;
    if per > 100_000.0 {
        println!("  {name:<48} {:>10.3} ms/op", per / 1e6);
    } else {
        println!("  {name:<48} {per:>10.1} ns/op");
    }
}

const N: usize = 5000;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    // Internal: measure exactly one cache shape and print its RSS delta.
    // Driven by `--residency` below, which re-execs us once per shape.
    if let Some(which) = args.iter().find_map(|a| a.strip_prefix("--measure=")) {
        measure_one(which);
    } else if args.iter().any(|a| a == "--residency") {
        residency();
    } else {
        timings();
    }
}

/// Build one cache shape and report how much RSS it cost.
///
/// Must run in a fresh process: measuring both shapes in sequence doesn't
/// work, because the allocator hands the second cache the pages the first
/// one just freed and RSS never moves.
fn measure_one(which: &str) {
    let Some(base) = rss() else { return };
    let bytes = match which {
        "value" => {
            let mut c: HashMap<String, Value> = HashMap::with_capacity(N);
            for i in 0..N {
                c.insert(uid_of(i), pod_row(i));
            }
            let d = rss().unwrap_or(base).saturating_sub(base);
            assert_eq!(c.len(), N, "keep the cache alive across the RSS read");
            d
        }
        _ => {
            let mut c: HashMap<String, RowJson> = HashMap::with_capacity(N);
            for i in 0..N {
                c.insert(uid_of(i), raw(&pod_row(i)));
            }
            let d = rss().unwrap_or(base).saturating_sub(base);
            assert_eq!(c.len(), N, "keep the cache alive across the RSS read");
            d
        }
    };
    println!("{bytes}");
}

fn residency() {
    if rss().is_none() {
        println!("--residency needs /proc/self/statm (Linux); nothing to report here");
        return;
    }
    println!("\n=== row representation: residency, {N} pod rows ===\n");

    let one = |which: &str| -> Option<usize> {
        let exe = std::env::current_exe().ok()?;
        let out = std::process::Command::new(exe)
            .arg(format!("--measure={which}"))
            .output()
            .ok()?;
        String::from_utf8_lossy(&out.stdout).trim().parse().ok()
    };

    let (Some(value_bytes), Some(row_bytes)) = (one("value"), one("rowjson")) else {
        println!("  could not re-exec for measurement");
        return;
    };

    println!(
        "  cache  HashMap<String, Value>    {:>8} KiB  ({:>5} B/row)",
        value_bytes / 1024,
        value_bytes / N
    );
    println!(
        "  cache  HashMap<String, RowJson>  {:>8} KiB  ({:>5} B/row)   {:.1}x smaller",
        row_bytes / 1024,
        row_bytes / N,
        value_bytes as f64 / row_bytes.max(1) as f64
    );
    println!(
        "\n  encoded row: {} B. The same data as a `Value` costs that plus \
         the tree:\n  one `Map` node and a separately-allocated `String` \
         per key, per row.\n",
        raw(&pod_row(0)).get().len()
    );
}

fn timings() {
    println!("\n=== row representation: timings, {N} pod rows ===\n");

    let row = pod_row(7);
    let row_same = pod_row(7);
    let a = raw(&row);
    let b = raw(&row_same);

    println!("--- per-apply, in the watcher task ---");
    bench(
        "was: Value::clone (deep)        [on change]",
        200_000,
        || {
            std::hint::black_box(row.clone());
        },
    );
    bench("was: Value == Value (tree walk) [always]", 200_000, || {
        std::hint::black_box(row == row_same);
    });
    bench(
        "now: RowJson::from_value        [on change]",
        200_000,
        || {
            std::hint::black_box(raw(&row));
        },
    );
    bench("now: RowJson == RowJson (memcmp)[always]", 500_000, || {
        std::hint::black_box(a == b);
    });
    bench(
        "now: RowJson::clone         [cache + channel]",
        2_000_000,
        || {
            std::hint::black_box(a.clone());
        },
    );

    println!("\n--- snapshot(), on every subscribe_resource ---");
    let mut cv: HashMap<String, Value> = HashMap::with_capacity(N);
    let mut cr: HashMap<String, RowJson> = HashMap::with_capacity(N);
    for i in 0..N {
        let r = pod_row(i);
        cr.insert(uid_of(i), raw(&r));
        cv.insert(uid_of(i), r);
    }
    bench("was: Vec<Value>   values().cloned()", 100, || {
        std::hint::black_box(cv.values().cloned().collect::<Vec<Value>>());
    });
    bench("now: Vec<RowJson> values().cloned()", 50_000, || {
        std::hint::black_box(cr.values().cloned().collect::<Vec<RowJson>>());
    });

    let snap_v: Vec<Value> = cv.values().cloned().collect();
    let snap_r: Vec<RowJson> = cr.values().cloned().collect();
    bench("was: to_string(Vec<Value>)   [command return]", 100, || {
        std::hint::black_box(serde_json::to_string(&snap_v).unwrap());
    });
    bench(
        "now: to_string(Vec<RowJson>) [command return]",
        2_000,
        || {
            std::hint::black_box(serde_json::to_string(&snap_r).unwrap());
        },
    );

    println!("\n--- emit batch, 1000 deltas = MAX_EMIT_DELTAS ---");
    let rows: Vec<Value> = (0..1000).map(pod_row).collect();
    let legacy: Vec<LegacyDelta> = rows
        .iter()
        .cloned()
        .map(|row| LegacyDelta::Upsert { row })
        .collect();
    let current: Vec<ResourceDelta> = rows
        .iter()
        .map(|r| ResourceDelta::Upsert { row: raw(r) })
        .collect();
    bench("was: to_string(Vec<Delta{Value}>)", 200, || {
        std::hint::black_box(serde_json::to_string(&legacy).unwrap());
    });
    bench("now: to_string(Vec<Delta{RowJson}>)", 10_000, || {
        std::hint::black_box(serde_json::to_string(&current).unwrap());
    });

    println!("\n--- search-index blob, per row, on the forwarder task ---");
    bench("was: serde_json::to_string(&Value)", 200_000, || {
        std::hint::black_box(serde_json::to_string(&row).unwrap());
    });
    bench("now: RowJson::get().to_owned()", 2_000_000, || {
        std::hint::black_box(a.get().to_owned());
    });

    println!("\n(run with --residency for memory accounting)\n");
}
