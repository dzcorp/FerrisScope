//! Connect-time search-index bootstrap.
//!
//! Issues a one-shot `LIST` (no watcher, no reflector) for a fixed
//! allowlist of well-known kinds and feeds the projected rows into a
//! caller-supplied upsert sink. Runs once per cluster connect — see
//! `crates/app/src/commands.rs::spawn_search_bootstrap`.
//!
//! Intentionally watcher-free: the lazy-reflector rule (`CLAUDE.md`)
//! still owns live data; this only seeds the search index so the header
//! palette has something useful to match against on a freshly-connected
//! cluster.

use kube::{api::Api, Client, ResourceExt};
use serde_json::Value;

use crate::registry::KindSpec;

/// One-shot LIST for `S` and feed each row into `upsert(kind_id, uid, &row)`.
/// Returns the number of rows fed. Errors are returned to the caller; the
/// caller logs and moves on to the next kind so a single failed list (auth,
/// quota) doesn't poison the whole bootstrap.
pub async fn bootstrap_kind<S: KindSpec>(
    client: Client,
    upsert: &(dyn Fn(&str, &str, &Value) + Sync),
) -> Result<usize, kube::Error> {
    let api: Api<S::K> = Api::all(client);
    let list = api.list(&kube::api::ListParams::default()).await?;
    let kind_id = S::meta().id;
    let mut n = 0usize;
    for obj in &list.items {
        let Some(uid) = obj.uid() else { continue };
        let mut row = S::project(obj);
        if let Value::Object(ref mut map) = row {
            map.insert("uid".to_owned(), Value::String(uid.clone()));
        }
        upsert(kind_id, &uid, &row);
        n += 1;
    }
    Ok(n)
}

/// Run [`bootstrap_kind`] for the standard 8-kind allowlist (pods,
/// deployments, nodes, services, namespaces, configmaps, secrets,
/// ingresses) sequentially. Per-kind errors are logged but never abort
/// the run — a 403 on Secrets shouldn't block Pod search.
pub async fn bootstrap_default(
    client: Client,
    upsert: &(dyn Fn(&str, &str, &Value) + Sync),
) -> usize {
    use crate::kinds::{
        config_maps::ConfigMapSpec, deployments::DeploymentSpec, ingresses::IngressSpec,
        namespaces::NamespaceSpec, nodes::NodeSpec, pods::PodSpec, secrets::SecretSpec,
        services::ServiceSpec,
    };

    async fn run<S: KindSpec>(
        client: Client,
        upsert: &(dyn Fn(&str, &str, &Value) + Sync),
    ) -> usize {
        let kind_id = S::meta().id;
        match bootstrap_kind::<S>(client, upsert).await {
            Ok(n) => {
                tracing::debug!(kind = kind_id, n, "bootstrap: ok");
                n
            }
            Err(e) => {
                tracing::info!(error = %e, kind = kind_id, "bootstrap: skipped");
                0
            }
        }
    }

    let mut total = 0;
    total += run::<NamespaceSpec>(client.clone(), upsert).await;
    total += run::<NodeSpec>(client.clone(), upsert).await;
    total += run::<PodSpec>(client.clone(), upsert).await;
    total += run::<DeploymentSpec>(client.clone(), upsert).await;
    total += run::<ServiceSpec>(client.clone(), upsert).await;
    total += run::<ConfigMapSpec>(client.clone(), upsert).await;
    total += run::<SecretSpec>(client.clone(), upsert).await;
    total += run::<IngressSpec>(client, upsert).await;
    total
}
