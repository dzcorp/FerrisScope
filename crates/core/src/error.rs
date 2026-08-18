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

    /// The plugin ran and refused because the cloud session lapsed: the
    /// credentials are intact, but the provider wants an identity challenge that
    /// needs a terminal (and usually a browser) the app cannot offer. Separate
    /// from [`Error::ExecPluginFailed`] because the only remedy is an
    /// interactive login, not a plugin or PATH fix.
    #[error("cloud session expired for {} — run `gcloud auth login{}` in a terminal ({message})",
        account.as_deref().unwrap_or("the active account"),
        account.as_ref().map(|a| format!(" --account={a}")).unwrap_or_default())]
    ExecReauthRequired {
        command: String,
        account: Option<String>,
        message: String,
    },

    /// The OS refused to execute the plugin's helper (macOS TCC on a
    /// Downloads/Desktop/Documents install, or a quarantine xattr). Separate
    /// from [`Error::ExecPluginFailed`] because no gcloud command fixes it —
    /// the remedy is a privacy grant or moving the SDK.
    #[error("the OS blocked the exec credential plugin '{command}' — operation not permitted{} ({message})",
        path.as_ref().map(|p| format!(" executing {p}")).unwrap_or_default())]
    ExecPluginBlocked {
        command: String,
        /// The blocked binary, when the plugin's stderr named it.
        path: Option<String>,
        message: String,
    },

    #[error("context not found: {0}")]
    ContextNotFound(String),

    #[error("invalid: {0}")]
    Invalid(String),

    #[error("ssh: {0}")]
    Ssh(String),
}

pub type Result<T> = std::result::Result<T, Error>;
