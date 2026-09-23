//! cargo run --release -p ferrisscope-kube-ext --example gitopsbench
use std::{error::Error, hint::black_box, io::Write, time::Instant};

use ferrisscope_kube_ext::well_known::lookup_by_gk;
use kube::api::DynamicObject;
use serde_json::{json, Value};

fn main() -> Result<(), Box<dyn Error>> {
    let mut objects: Vec<DynamicObject> = serde_json::from_str(include_str!(
        "../../../tests/fixtures/well_known/gitops.json"
    ))?;
    let mut large = objects[0].clone();
    large.data["status"]["resources"] = Value::Array((0..2000).map(|i| json!({"group":"apps","kind":"Deployment","namespace":"prod","name":format!("workload-{i}"),"status":"Synced","health":{"status":"Healthy"}})).collect());
    let original_application = objects[0].clone();
    let original_kustomization = objects[3].clone();
    objects.push(large);
    let mut large = original_kustomization.clone();
    large.data["status"]["inventory"]["entries"] = Value::Array(
        (0..2000)
            .map(|i| json!({"id":format!("prod_workload-{i}_apps_Deployment"),"v":"v1"}))
            .collect(),
    );
    objects.push(large);
    let mut output = std::io::stdout().lock();
    writeln!(
        output,
        "kind | resources | row+JSON ns/op | detail+JSON us/op | row bytes | detail bytes"
    )?;
    for obj in &objects {
        let types = obj.types.as_ref().ok_or("missing kind")?;
        let group = types.api_version.split_once('/').ok_or("missing group")?.0;
        let wk = lookup_by_gk(group, &types.kind).ok_or("missing override")?;
        let resources = obj
            .data
            .pointer("/status/resources")
            .or_else(|| obj.data.pointer("/status/inventory/entries"))
            .and_then(Value::as_array)
            .map_or(0, Vec::len);
        for _ in 0..100 {
            black_box((wk.project)(black_box(obj)));
        }
        let start = Instant::now();
        for _ in 0..20_000 {
            black_box(serde_json::to_vec(&(wk.project)(black_box(obj)))?);
        }
        let row_ns = start.elapsed().as_nanos() / 20_000;
        let iterations = if resources > 100 { 100 } else { 1000 };
        let start = Instant::now();
        for _ in 0..iterations {
            black_box(serde_json::to_vec(&(wk.project_detail)(black_box(obj)))?);
        }
        let detail_us = start.elapsed().as_micros() as f64 / f64::from(iterations);
        let row_bytes = serde_json::to_vec(&(wk.project)(obj))?.len();
        let detail_bytes = serde_json::to_vec(&(wk.project_detail)(obj))?.len();
        if resources == 2000 {
            let original = if types.kind == "Application" {
                &original_application
            } else {
                &original_kustomization
            };
            assert_eq!((wk.project)(obj), (wk.project)(original));
        }
        writeln!(
            output,
            "{} | {resources} | {row_ns} | {detail_us:.1} | {row_bytes} | {detail_bytes}",
            types.kind
        )?;
    }
    Ok(())
}
