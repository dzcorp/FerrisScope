//! kind-cluster harness for integration tests.
//!
//! Boots two named clusters at slightly different K8s versions, exposes a
//! `kube::Client` per context, and tears them down on drop unless
//! `FERRISSCOPE_KEEP_CLUSTERS=1` is set (handy for iteration).
//!
//! Idempotent: if a cluster with the expected name already exists, it's
//! reused. CI gets a fresh boot; local dev gets fast reruns.
//!
//! Gated behind the `integration` feature.

use std::process::{Command, Stdio};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use kube::config::{KubeConfigOptions, Kubeconfig};
use kube::{Client, Config};
use thiserror::Error;
use tokio::time::sleep;

#[derive(Debug, Error)]
pub enum KindError {
    #[error("kind binary not found on PATH; install kind 0.20+ to run integration tests")]
    KindMissing,
    #[error("docker not reachable: {0}")]
    DockerUnavailable(String),
    #[error("kind command failed: {cmd}: {stderr}")]
    Command { cmd: String, stderr: String },
    #[error("kubeconfig parse: {0}")]
    Kubeconfig(#[from] kube::config::KubeconfigError),
    #[error("kube config infer: {0}")]
    InferConfig(#[from] kube::config::InferConfigError),
    #[error("kube client build: {0}")]
    Client(#[from] kube::Error),
    #[error("timed out waiting for cluster {name} to become ready")]
    ReadyTimeout { name: String },
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
}

pub type Result<T> = std::result::Result<T, KindError>;

/// One kind cluster with a derived kube `Client`.
pub struct KindCluster {
    pub name: String,
    pub context_name: String,
    pub k8s_version: String,
    pub kubeconfig_text: String,
    pub client: Client,
    /// Whether this harness booted the cluster (and therefore should delete
    /// it on drop). False if we attached to a pre-existing one.
    owns_cluster: bool,
}

impl KindCluster {
    /// Boot (or reuse) a kind cluster with the given name + image. The image
    /// pin (e.g. `kindest/node:v1.31.4`) determines the K8s version.
    pub async fn ensure(name: &str, image: &str) -> Result<Self> {
        require_kind()?;
        require_docker()?;

        let owns_cluster = if cluster_exists(name)? {
            tracing::info!(cluster = name, "reusing existing kind cluster");
            false
        } else {
            tracing::info!(cluster = name, image, "creating kind cluster");
            run_kind(&[
                "create", "cluster", "--name", name, "--image", image, "--wait", "120s",
            ])?;
            true
        };

        let kubeconfig_text = run_kind(&["get", "kubeconfig", "--name", name])?;
        let kubeconfig = Kubeconfig::from_yaml(&kubeconfig_text)?;
        let context_name = format!("kind-{name}");
        let options = KubeConfigOptions {
            context: Some(context_name.clone()),
            ..Default::default()
        };
        let config = Config::from_custom_kubeconfig(kubeconfig, &options).await?;
        let client = Client::try_from(config)?;

        wait_for_ready(&client, name).await?;

        let k8s_version = client
            .apiserver_version()
            .await
            .map(|v| v.git_version)
            .unwrap_or_default();

        Ok(Self {
            name: name.to_owned(),
            context_name,
            k8s_version,
            kubeconfig_text,
            client,
            owns_cluster,
        })
    }

    /// Apply a YAML manifest via `kubectl apply -f -`. Used by per-test
    /// fixture loaders — easier and more robust than reimplementing
    /// multi-document YAML splitting + dynamic apply for fixtures.
    pub fn kubectl_apply(&self, manifest_yaml: &str) -> Result<()> {
        let mut cmd = Command::new("kubectl");
        cmd.args(["--context", &self.context_name, "apply", "-f", "-"]);
        cmd.stdin(Stdio::piped());
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::piped());
        let mut child = cmd.spawn().map_err(|e| KindError::Command {
            cmd: "kubectl apply".into(),
            stderr: e.to_string(),
        })?;
        if let Some(stdin) = child.stdin.take() {
            use std::io::Write;
            let mut stdin = stdin;
            stdin.write_all(manifest_yaml.as_bytes())?;
        }
        let output = child.wait_with_output()?;
        if !output.status.success() {
            return Err(KindError::Command {
                cmd: "kubectl apply".into(),
                stderr: String::from_utf8_lossy(&output.stderr).to_string(),
            });
        }
        Ok(())
    }

    /// Run an arbitrary `kubectl` invocation against this cluster, returning
    /// stdout on success.
    pub fn kubectl(&self, args: &[&str]) -> Result<String> {
        let mut cmd = Command::new("kubectl");
        cmd.args(["--context", &self.context_name]);
        cmd.args(args);
        let output = cmd.output()?;
        if !output.status.success() {
            return Err(KindError::Command {
                cmd: format!("kubectl {}", args.join(" ")),
                stderr: String::from_utf8_lossy(&output.stderr).to_string(),
            });
        }
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    }

    /// Install the Gateway API CRDs (standard channel, the version pinned
    /// here) into this cluster. Idempotent — `kubectl apply` re-applies
    /// without errors. Used by Layer 2f tests.
    ///
    /// `--server-side=true` is required: client-side apply stuffs the full
    /// manifest into a `last-applied-configuration` annotation, and CRDs
    /// with large schemas (Envoy Gateway's, Argo's) exceed the 262 KiB
    /// metadata.annotations limit. Server-side apply tracks ownership in
    /// `managedFields` instead.
    pub fn install_gateway_api_crds(&self) -> Result<()> {
        // Pinned to v1.2.1 (current stable as of 2026-Q2). Bump when
        // upstream cuts a release that changes the served versions in
        // ways our well-known overrides need.
        const URL: &str = "https://github.com/kubernetes-sigs/gateway-api/releases/download/v1.2.1/standard-install.yaml";
        self.kubectl(&[
            "apply",
            "--server-side=true",
            "--force-conflicts",
            "-f",
            URL,
        ])
        .map(|_| ())
    }

    /// Install Envoy Gateway via its release manifest. Requires the Gateway
    /// API CRDs to already be installed. Same `--server-side=true` reason
    /// as `install_gateway_api_crds` — Envoy's CRD schema busts the 262 KiB
    /// annotation cap on a client-side apply.
    pub fn install_envoy_gateway(&self) -> Result<()> {
        const URL: &str =
            "https://github.com/envoyproxy/gateway/releases/download/v1.2.4/install.yaml";
        self.kubectl(&[
            "apply",
            "--server-side=true",
            "--force-conflicts",
            "-f",
            URL,
        ])
        .map(|_| ())?;
        // Wait for the deployment to become Available so the controller is
        // actually reconciling Gateway/HTTPRoute objects we apply next.
        self.kubectl(&[
            "-n",
            "envoy-gateway-system",
            "wait",
            "deployment/envoy-gateway",
            "--for=condition=Available",
            "--timeout=180s",
        ])
        .map(|_| ())
    }

    /// Mint a kubeconfig that authenticates as a specific ServiceAccount in
    /// this cluster, with whatever RBAC the SA has. Used by Layer 2e
    /// limited-RBAC tests — the harness creates the SA + Role + Binding in
    /// the YAML, then this helper produces the kubeconfig that uses the
    /// SA's token. Returns the kubeconfig YAML text.
    ///
    /// Approach: bake the SA token + apiserver URL + CA into a fresh
    /// kubeconfig. Same flow `kubectl config set-credentials --token` uses,
    /// but rendered directly so we don't need to mutate the test's main
    /// kubeconfig.
    pub fn kubeconfig_for_serviceaccount(&self, namespace: &str, sa_name: &str) -> Result<String> {
        // Create a TokenRequest for the SA — modern (1.24+) replacement for
        // the auto-mounted Secret tokens.
        let token = self
            .kubectl(&["create", "token", sa_name, "-n", namespace, "--duration=1h"])?
            .trim()
            .to_owned();
        if token.is_empty() {
            return Err(KindError::Command {
                cmd: "kubectl create token".into(),
                stderr: "empty token".into(),
            });
        }

        // Pull the cluster server + CA out of the harness's own kubeconfig
        // so the new file points at the same apiserver.
        let kc: serde_yaml::Value =
            serde_yaml::from_str(&self.kubeconfig_text).map_err(|e| KindError::Command {
                cmd: "parse kubeconfig".into(),
                stderr: e.to_string(),
            })?;
        let cluster = kc
            .get("clusters")
            .and_then(|v| v.as_sequence())
            .and_then(|s| s.first())
            .and_then(|c| c.get("cluster"))
            .ok_or_else(|| KindError::Command {
                cmd: "kubeconfig clusters".into(),
                stderr: "missing".into(),
            })?;
        let server = cluster
            .get("server")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_owned();
        let ca = cluster
            .get("certificate-authority-data")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_owned();

        Ok(format!(
            "apiVersion: v1\nkind: Config\ncurrent-context: sa-ctx\nclusters:\n- name: kind\n  cluster:\n    server: {server}\n    certificate-authority-data: {ca}\nusers:\n- name: sa\n  user:\n    token: {token}\ncontexts:\n- name: sa-ctx\n  context:\n    cluster: kind\n    user: sa\n    namespace: {namespace}\n"
        ))
    }
}

impl Drop for KindCluster {
    fn drop(&mut self) {
        // Don't delete clusters we attached to; only delete what we created.
        // FERRISSCOPE_KEEP_CLUSTERS=1 keeps even our own clusters alive for
        // post-mortem inspection.
        if !self.owns_cluster {
            return;
        }
        if std::env::var_os("FERRISSCOPE_KEEP_CLUSTERS").is_some() {
            tracing::info!(
                cluster = %self.name,
                "FERRISSCOPE_KEEP_CLUSTERS set; leaving cluster running"
            );
            return;
        }
        tracing::info!(cluster = %self.name, "deleting kind cluster");
        if let Err(e) = run_kind(&["delete", "cluster", "--name", &self.name]) {
            tracing::warn!(error = %e, "kind delete cluster failed");
        }
    }
}

fn require_kind() -> Result<()> {
    static OK: OnceLock<bool> = OnceLock::new();
    if *OK.get_or_init(|| which::which("kind").is_ok()) {
        Ok(())
    } else {
        Err(KindError::KindMissing)
    }
}

fn require_docker() -> Result<()> {
    let status = Command::new("docker")
        .arg("info")
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .output();
    match status {
        Ok(o) if o.status.success() => Ok(()),
        Ok(o) => Err(KindError::DockerUnavailable(
            String::from_utf8_lossy(&o.stderr).to_string(),
        )),
        Err(e) => Err(KindError::DockerUnavailable(e.to_string())),
    }
}

fn cluster_exists(name: &str) -> Result<bool> {
    let out = run_kind(&["get", "clusters"])?;
    Ok(out.lines().any(|line| line.trim() == name))
}

fn run_kind(args: &[&str]) -> Result<String> {
    let output = Command::new("kind").args(args).output()?;
    if !output.status.success() {
        return Err(KindError::Command {
            cmd: format!("kind {}", args.join(" ")),
            stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        });
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

/// Stable cluster names so reruns reuse what's already there. Pin the K8s
/// versions explicitly — Layer 2e wants version skew between A and B.
pub mod cluster_names {
    pub const PRIMARY: &str = "ferrisscope-it-a";
    pub const PRIMARY_IMAGE: &str = "kindest/node:v1.31.4";
    pub const SECONDARY: &str = "ferrisscope-it-b";
    pub const SECONDARY_IMAGE: &str = "kindest/node:v1.29.10";
}

/// Boot (or reuse) both integration clusters in parallel. Returns owned
/// `KindCluster` handles so the caller can use Drop semantics for cleanup
/// or explicitly call `forget()` on them when sharing across tests.
pub async fn ensure_two_clusters() -> Result<(KindCluster, KindCluster)> {
    use cluster_names::{PRIMARY, PRIMARY_IMAGE, SECONDARY, SECONDARY_IMAGE};
    // Run the two creates concurrently so the worst-case is one cluster's
    // boot time, not two.
    let (a, b) = tokio::join!(
        KindCluster::ensure(PRIMARY, PRIMARY_IMAGE),
        KindCluster::ensure(SECONDARY, SECONDARY_IMAGE),
    );
    Ok((a?, b?))
}

/// Poll for the apiserver responding + at least one Ready node. The kind
/// `--wait` flag covers most of this but flaky CI runners occasionally
/// finish `create` before nodes flip Ready.
async fn wait_for_ready(client: &Client, name: &str) -> Result<()> {
    use k8s_openapi::api::core::v1::Node;
    use kube::api::{Api, ListParams};

    let api: Api<Node> = Api::all(client.clone());
    let deadline = Instant::now() + Duration::from_secs(120);
    while Instant::now() < deadline {
        match api.list(&ListParams::default()).await {
            Ok(list) => {
                let any_ready = list.items.iter().any(|n| {
                    n.status
                        .as_ref()
                        .and_then(|s| s.conditions.as_ref())
                        .map(|cs| cs.iter().any(|c| c.type_ == "Ready" && c.status == "True"))
                        .unwrap_or(false)
                });
                if any_ready {
                    return Ok(());
                }
            }
            Err(e) => {
                tracing::debug!(error = %e, "wait_for_ready: node list pending");
            }
        }
        sleep(Duration::from_secs(2)).await;
    }
    Err(KindError::ReadyTimeout {
        name: name.to_owned(),
    })
}
