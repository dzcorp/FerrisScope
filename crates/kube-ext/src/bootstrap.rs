//! Connect-time search-index bootstrap.
//!
//! Issues a one-shot paginated `LIST` (no watcher, no reflector) for a fixed
//! allowlist of well-known kinds and feeds the projected rows into a
//! caller-supplied upsert sink. Runs once per cluster connect — see
//! `crates/app/src/commands.rs::spawn_search_bootstrap`.
//!
//! Intentionally watcher-free: the lazy-reflector rule (`CLAUDE.md`)
//! still owns live data; this only seeds the search index so the header
//! palette has something useful to match against on a freshly-connected
//! cluster.
//!
//! Each *complete* listing also drives a reconcile (`retain` sink): rows of
//! that kind missing from the LIST are tombstoned, so objects deleted while
//! the app wasn't watching stop matching searches. Truncated listings (the
//! per-kind cap fired) skip the reconcile — tombstoning everything past the
//! cap would lie harder than keeping a few stale rows.

use kube::{api::Api, api::ListParams, Client, ResourceExt};
use serde_json::Value;

use crate::registry::KindSpec;

/// Page size for the bootstrap LISTs. Bounds the apiserver's per-request
/// work and our peak memory; the loop walks `continue` tokens until done.
const PAGE_LIMIT: u32 = 500;

/// Per-kind ceiling on indexed rows. A 50k-pod cluster doesn't need every
/// pod searchable from the bootstrap — anything the operator actually
/// browses is indexed live by the watcher path anyway.
pub const MAX_BOOTSTRAP_ROWS: usize = 5_000;

/// Outcome of one kind's bootstrap LIST.
pub struct BootstrapKind {
    /// uids fed to the upsert sink, in listing order.
    pub uids: Vec<String>,
    /// `false` when the per-kind cap stopped the listing early — the uid
    /// set is then a prefix, not the full population, and MUST NOT be used
    /// to reconcile deletions.
    pub complete: bool,
}

/// Whether a listing that just consumed a page should fetch another, and
/// with which token. Pure — split out for tests.
fn next_page(seen: usize, continue_token: Option<&str>) -> Option<String> {
    if seen >= MAX_BOOTSTRAP_ROWS {
        return None;
    }
    match continue_token {
        Some(t) if !t.is_empty() => Some(t.to_owned()),
        _ => None,
    }
}

/// Paginated LIST for `S`, feeding each row into `upsert(kind_id, uid, &row)`.
/// Errors are returned to the caller; the caller logs and moves on to the
/// next kind so a single failed list (auth, quota) doesn't poison the whole
/// bootstrap.
pub async fn bootstrap_kind<S: KindSpec>(
    client: Client,
    upsert: &(dyn Fn(&str, &str, &Value) + Sync),
) -> Result<BootstrapKind, kube::Error> {
    let api: Api<S::K> = Api::all(client);
    let kind_id = S::meta().id;
    let mut uids: Vec<String> = Vec::new();
    let mut token: Option<String> = None;
    loop {
        let mut lp = ListParams::default().limit(PAGE_LIMIT);
        if let Some(t) = &token {
            lp = lp.continue_token(t);
        }
        let list = api.list(&lp).await?;
        let returned_continue = list.metadata.continue_.clone();
        for obj in &list.items {
            let Some(uid) = obj.uid() else { continue };
            let mut row = S::project(obj);
            if let Value::Object(ref mut map) = row {
                map.insert("uid".to_owned(), Value::String(uid.clone()));
            }
            upsert(kind_id, &uid, &row);
            uids.push(uid);
        }
        token = next_page(uids.len(), returned_continue.as_deref());
        if token.is_none() {
            // Complete unless the apiserver still had pages to give when
            // the cap stopped us.
            let truncated = uids.len() >= MAX_BOOTSTRAP_ROWS
                && returned_continue.as_deref().is_some_and(|t| !t.is_empty());
            return Ok(BootstrapKind {
                uids,
                complete: !truncated,
            });
        }
    }
}

/// Run [`bootstrap_kind`] for the standard 8-kind allowlist (pods,
/// deployments, nodes, services, namespaces, configmaps, secrets,
/// ingresses) sequentially. Per-kind errors are logged but never abort
/// the run — a 403 on Secrets shouldn't block Pod search.
///
/// `retain(kind_id, uids)` fires once per kind whose listing came back
/// complete; the sink is expected to tombstone that kind's rows missing
/// from `uids`. Failed or truncated listings skip it.
pub async fn bootstrap_default(
    client: Client,
    upsert: &(dyn Fn(&str, &str, &Value) + Sync),
    retain: &(dyn Fn(&str, Vec<String>) + Sync),
) -> usize {
    use crate::kinds::{
        config_maps::ConfigMapSpec, deployments::DeploymentSpec, ingresses::IngressSpec,
        namespaces::NamespaceSpec, nodes::NodeSpec, pods::PodSpec, secrets::SecretSpec,
        services::ServiceSpec,
    };

    async fn run<S: KindSpec>(
        client: Client,
        upsert: &(dyn Fn(&str, &str, &Value) + Sync),
        retain: &(dyn Fn(&str, Vec<String>) + Sync),
    ) -> usize {
        let kind_id = S::meta().id;
        match bootstrap_kind::<S>(client, upsert).await {
            Ok(res) => {
                let n = res.uids.len();
                tracing::debug!(kind = kind_id, n, complete = res.complete, "bootstrap: ok");
                if res.complete {
                    retain(kind_id, res.uids);
                } else {
                    tracing::info!(
                        kind = kind_id,
                        n,
                        "bootstrap: listing truncated at cap, skipping deletion reconcile"
                    );
                }
                n
            }
            Err(e) => {
                tracing::info!(error = %e, kind = kind_id, "bootstrap: skipped");
                0
            }
        }
    }

    let mut total = 0;
    total += run::<NamespaceSpec>(client.clone(), upsert, retain).await;
    total += run::<NodeSpec>(client.clone(), upsert, retain).await;
    total += run::<PodSpec>(client.clone(), upsert, retain).await;
    total += run::<DeploymentSpec>(client.clone(), upsert, retain).await;
    total += run::<ServiceSpec>(client.clone(), upsert, retain).await;
    total += run::<ConfigMapSpec>(client.clone(), upsert, retain).await;
    total += run::<SecretSpec>(client.clone(), upsert, retain).await;
    total += run::<IngressSpec>(client, upsert, retain).await;
    total
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn next_page_follows_non_empty_tokens_under_the_cap() {
        assert_eq!(next_page(10, Some("tok")), Some("tok".to_owned()));
        assert_eq!(next_page(10, Some("")), None);
        assert_eq!(next_page(10, None), None);
    }

    #[test]
    fn next_page_stops_at_the_cap_even_with_a_token() {
        assert_eq!(next_page(MAX_BOOTSTRAP_ROWS, Some("tok")), None);
        assert_eq!(next_page(MAX_BOOTSTRAP_ROWS + 1, Some("tok")), None);
    }
}
