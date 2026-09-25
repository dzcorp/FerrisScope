//! Connect-time search-index bootstrap.
//!
//! Issues a one-shot paginated metadata-only `LIST` (no watcher, no
//! reflector) for a fixed allowlist of well-known kinds and feeds each
//! object's identity + labels — all the index stores — into a caller-supplied
//! upsert sink. Metadata-only keeps Secret / ConfigMap payloads and full pod
//! specs off the wire. Runs once per cluster connect — see
//! `crates/app/src/commands.rs::spawn_search_bootstrap`.
//!
//! Intentionally watcher-free: the lazy-reflector rule (`CLAUDE.md`)
//! still owns live data; this only seeds the search index so the header
//! palette has something useful to match against on a freshly-connected
//! cluster. The index is empty when this runs (it is recreated per
//! connection), so there is nothing stale to reconcile.

use kube::{api::Api, api::ListParams, Client, ResourceExt};

use crate::registry::KindSpec;

/// Page size for the bootstrap LISTs. Bounds the apiserver's per-request
/// work and our peak memory; the loop walks `continue` tokens until done.
const PAGE_LIMIT: u32 = 500;

/// Per-kind ceiling on indexed rows. A 50k-pod cluster doesn't need every
/// pod searchable from the bootstrap — anything the operator actually
/// browses is indexed live by the watcher path anyway.
pub const MAX_BOOTSTRAP_ROWS: usize = 5_000;

/// What the bootstrap hands the index for one object.
pub struct IndexedObject {
    pub uid: String,
    pub namespace: Option<String>,
    pub name: String,
    /// [`ferrisscope_core::search::label_terms`] of the object's labels.
    pub labels: String,
}

impl IndexedObject {
    /// `None` for an object without a uid or name — nothing to key or show.
    fn from_meta<K: ResourceExt>(obj: &K) -> Option<Self> {
        let uid = obj.uid()?;
        let name = obj.meta().name.clone().filter(|n| !n.is_empty())?;
        Some(Self {
            uid,
            namespace: obj.namespace().filter(|n| !n.is_empty()),
            name,
            labels: ferrisscope_core::search::label_terms(
                obj.labels().iter().map(|(k, v)| (k.as_str(), v.as_str())),
            ),
        })
    }
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

/// Paginated metadata-only LIST for `S`, feeding each object into
/// `upsert(kind_id, &obj)`. Errors are returned to the caller; the caller
/// logs and moves on to the next kind so a single failed list (auth, quota)
/// doesn't poison the whole bootstrap.
/// Returns the number of objects fed.
pub async fn bootstrap_kind<S: KindSpec>(
    client: Client,
    upsert: &(dyn Fn(&str, &IndexedObject) + Sync),
) -> Result<usize, kube::Error> {
    let api: Api<S::K> = Api::all(client);
    let kind_id = S::meta().id;
    let mut seen = 0;
    let mut token: Option<String> = None;
    loop {
        let mut lp = ListParams::default().limit(PAGE_LIMIT);
        if let Some(t) = &token {
            lp = lp.continue_token(t);
        }
        let list = api.list_metadata(&lp).await?;
        for obj in list.items.iter().filter_map(IndexedObject::from_meta) {
            upsert(kind_id, &obj);
            seen += 1;
        }
        token = next_page(seen, list.metadata.continue_.as_deref());
        if token.is_none() {
            return Ok(seen);
        }
    }
}

/// Run [`bootstrap_kind`] for the standard 8-kind allowlist (pods,
/// deployments, nodes, services, namespaces, configmaps, secrets,
/// ingresses) sequentially. Per-kind errors are logged but never abort
/// the run — a 403 on Secrets shouldn't block Pod search.
pub async fn bootstrap_default(
    client: Client,
    upsert: &(dyn Fn(&str, &IndexedObject) + Sync),
) -> usize {
    use crate::kinds::{
        config_maps::ConfigMapSpec, deployments::DeploymentSpec, ingresses::IngressSpec,
        namespaces::NamespaceSpec, nodes::NodeSpec, pods::PodSpec, secrets::SecretSpec,
        services::ServiceSpec,
    };

    async fn run<S: KindSpec>(
        client: Client,
        upsert: &(dyn Fn(&str, &IndexedObject) + Sync),
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
    fn indexed_object_takes_identity_and_labels_from_metadata() {
        use k8s_openapi::api::core::v1::Secret;
        use kube::core::{ObjectMeta, PartialObjectMeta};

        let meta =
            |uid: Option<&str>, name: Option<&str>, ns: Option<&str>| PartialObjectMeta::<Secret> {
                types: None,
                metadata: ObjectMeta {
                    uid: uid.map(str::to_owned),
                    name: name.map(str::to_owned),
                    namespace: ns.map(str::to_owned),
                    labels: Some(
                        [
                            ("app".to_owned(), "api".to_owned()),
                            ("tier".to_owned(), "web".to_owned()),
                        ]
                        .into(),
                    ),
                    ..ObjectMeta::default()
                },
                _phantom: std::marker::PhantomData,
            };

        let obj = IndexedObject::from_meta(&meta(Some("u1"), Some("tls"), Some("prod"))).unwrap();
        assert_eq!((obj.uid.as_str(), obj.name.as_str()), ("u1", "tls"));
        assert_eq!(obj.namespace.as_deref(), Some("prod"));
        assert_eq!(obj.labels, "app=api tier=web");

        assert!(IndexedObject::from_meta(&meta(None, Some("tls"), None)).is_none());
        assert!(IndexedObject::from_meta(&meta(Some("u1"), Some(""), None)).is_none());
        let cluster = IndexedObject::from_meta(&meta(Some("u1"), Some("n1"), Some(""))).unwrap();
        assert_eq!(cluster.namespace, None);
    }

    #[test]
    fn next_page_stops_at_the_cap_even_with_a_token() {
        assert_eq!(next_page(MAX_BOOTSTRAP_ROWS, Some("tok")), None);
        assert_eq!(next_page(MAX_BOOTSTRAP_ROWS + 1, Some("tok")), None);
    }
}
