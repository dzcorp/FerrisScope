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

    #[error("context not found: {0}")]
    ContextNotFound(String),

    #[error("invalid: {0}")]
    Invalid(String),

    #[error("ssh: {0}")]
    Ssh(String),
}

pub type Result<T> = std::result::Result<T, Error>;
