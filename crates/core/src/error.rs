use thiserror::Error;

#[derive(Debug, Error)]
pub enum Error {
    #[error("kubeconfig: {0}")]
    Kubeconfig(#[from] kube::config::KubeconfigError),

    #[error("kube client: {0}")]
    Kube(#[from] kube::Error),

    #[error("io: {0}")]
    Io(#[from] std::io::Error),

    #[error("yaml: {0}")]
    Yaml(#[from] serde_yaml::Error),

    #[error("exec credential plugin '{command}' not found on PATH — {hint}")]
    ExecPluginNotFound { command: String, hint: String },

    /// The exec plugin ran but exited non-zero. kube-rs captures the plugin's
    /// stdout/stderr but only Display-prints it as raw bytes; we reformat the
    /// stderr as readable, redacted, truncated UTF-8 so the operator sees the
    /// real cause (e.g. "gcloud auth login required", expired creds).
    #[error("exec credential plugin '{command}' failed (exit {code}) — {stderr}")]
    ExecPluginFailed {
        command: String,
        code: String,
        stderr: String,
    },

    #[error("context not found: {0}")]
    ContextNotFound(String),

    #[error("invalid: {0}")]
    Invalid(String),

    #[error("ssh: {0}")]
    Ssh(String),
}

pub type Result<T> = std::result::Result<T, Error>;
