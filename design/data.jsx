// Shared mock data for all four variants.
// 6 clusters across regions; pods/nodes/configmaps per cluster.
// Original product name: "Helmsman" — a generic K8s control plane.

const CLUSTERS = [
  {
    id: 'prod-eu',
    name: 'prod-eu-west',
    region: 'eu-west-1',
    provider: 'AWS · EKS',
    version: '1.29.4',
    status: 'healthy',
    nodes: 24,
    pods: 412,
    cpu: 0.62,
    mem: 0.71,
    accent: 'emerald',
    env: 'production',
    namespaces: ['default', 'payments', 'checkout', 'observability', 'kube-system'],
  },
  {
    id: 'prod-us',
    name: 'prod-us-east',
    region: 'us-east-2',
    provider: 'AWS · EKS',
    version: '1.29.4',
    status: 'healthy',
    nodes: 32,
    pods: 587,
    cpu: 0.74,
    mem: 0.68,
    accent: 'emerald',
    env: 'production',
    namespaces: ['default', 'payments', 'checkout', 'auth', 'observability', 'kube-system'],
  },
  {
    id: 'prod-ap',
    name: 'prod-ap-south',
    region: 'ap-southeast-1',
    provider: 'GCP · GKE',
    version: '1.28.7',
    status: 'degraded',
    nodes: 16,
    pods: 248,
    cpu: 0.81,
    mem: 0.83,
    accent: 'amber',
    env: 'production',
    namespaces: ['default', 'payments', 'checkout', 'kube-system'],
  },
  {
    id: 'staging',
    name: 'staging-eu',
    region: 'eu-central-1',
    provider: 'AWS · EKS',
    version: '1.30.1',
    status: 'healthy',
    nodes: 8,
    pods: 142,
    cpu: 0.34,
    mem: 0.41,
    accent: 'sky',
    env: 'staging',
    namespaces: ['default', 'payments', 'checkout', 'qa', 'kube-system'],
  },
  {
    id: 'dev',
    name: 'dev-shared',
    region: 'eu-central-1',
    provider: 'AWS · EKS',
    version: '1.30.1',
    status: 'healthy',
    nodes: 4,
    pods: 78,
    cpu: 0.22,
    mem: 0.31,
    accent: 'sky',
    env: 'development',
    namespaces: ['default', 'sandbox', 'kube-system'],
  },
  {
    id: 'edge',
    name: 'edge-cdn',
    region: 'multi-region',
    provider: 'Bare metal · k3s',
    version: '1.27.9',
    status: 'warning',
    nodes: 12,
    pods: 96,
    cpu: 0.45,
    mem: 0.52,
    accent: 'rose',
    env: 'production',
    namespaces: ['default', 'edge', 'cdn', 'kube-system'],
  },
];

// Pod templates per cluster — only first 12 are detailed; counts are mocked.
const PODS_BY_CLUSTER = {
  'prod-eu': [
    { name: 'checkout-api-7d4f8b9-xk2lp', ns: 'checkout', node: 'ip-10-2-3-12', status: 'Running', restarts: 0, age: '4d', cpu: 142, mem: 384, ready: '1/1', image: 'checkout-api:v2.14.3' },
    { name: 'checkout-api-7d4f8b9-h8mqr', ns: 'checkout', node: 'ip-10-2-3-14', status: 'Running', restarts: 0, age: '4d', cpu: 138, mem: 372, ready: '1/1', image: 'checkout-api:v2.14.3' },
    { name: 'checkout-api-7d4f8b9-pz3wt', ns: 'checkout', node: 'ip-10-2-4-08', status: 'Running', restarts: 1, age: '4d', cpu: 156, mem: 401, ready: '1/1', image: 'checkout-api:v2.14.3' },
    { name: 'checkout-api-canary-9b8-mx2', ns: 'checkout', node: 'ip-10-2-3-14', status: 'ContainerCreating', restarts: 0, age: '8s', cpu: 0, mem: 0, ready: '0/1', image: 'checkout-api:v2.15.0' },
    { name: 'checkout-api-7d4f8b9-old-z2', ns: 'checkout', node: 'ip-10-2-4-08', status: 'Terminating', restarts: 0, age: '4d', cpu: 18, mem: 142, ready: '1/1', image: 'checkout-api:v2.14.2' },
    { name: 'payments-worker-58c4-vx9k', ns: 'payments', node: 'ip-10-2-5-21', status: 'Running', restarts: 0, age: '12d', cpu: 89, mem: 256, ready: '1/1', image: 'payments-worker:v3.1.0' },
    { name: 'payments-worker-58c4-bn2j', ns: 'payments', node: 'ip-10-2-5-23', status: 'Running', restarts: 0, age: '12d', cpu: 94, mem: 262, ready: '1/1', image: 'payments-worker:v3.1.0' },
    { name: 'payments-api-9f7d-qm4lp', ns: 'payments', node: 'ip-10-2-3-12', status: 'Running', restarts: 0, age: '8h', cpu: 212, mem: 512, ready: '1/1', image: 'payments-api:v4.0.1' },
    { name: 'payments-api-9f7d-init-tk', ns: 'payments', node: 'ip-10-2-3-14', status: 'Init', restarts: 0, age: '14s', cpu: 8, mem: 24, ready: '0/1', image: 'payments-api:v4.0.1', initStep: '1/3' },
    { name: 'fraud-check-6b2c-tx8nm', ns: 'payments', node: 'ip-10-2-4-08', status: 'CrashLoopBackOff', restarts: 14, age: '2h', cpu: 0, mem: 128, ready: '0/1', image: 'fraud-check:v1.8.2' },
    { name: 'fraud-check-6b2c-old-rr1', ns: 'payments', node: 'ip-10-2-4-09', status: 'OOMKilled', restarts: 8, age: '40m', cpu: 0, mem: 0, ready: '0/1', image: 'fraud-check:v1.8.1' },
    { name: 'db-migrate-9c4d-job-x82', ns: 'payments', node: 'ip-10-2-5-21', status: 'Completed', restarts: 0, age: '6h', cpu: 0, mem: 0, ready: '0/1', image: 'db-migrate:v4.0.1' },
    { name: 'prom-server-0', ns: 'observability', node: 'ip-10-2-6-44', status: 'Running', restarts: 0, age: '32d', cpu: 480, mem: 2048, ready: '2/2', image: 'prometheus:v2.51' },
    { name: 'grafana-7f8d-jk9pp', ns: 'observability', node: 'ip-10-2-6-44', status: 'Running', restarts: 0, age: '32d', cpu: 124, mem: 384, ready: '1/1', image: 'grafana:10.4.2' },
    { name: 'loki-querier-2', ns: 'observability', node: 'ip-10-2-6-46', status: 'Running', restarts: 2, age: '3d', cpu: 380, mem: 1024, ready: '1/1', image: 'loki:2.9.4' },
    { name: 'loki-ingester-evicted-7t', ns: 'observability', node: 'ip-10-2-6-44', status: 'Evicted', restarts: 0, age: '4h', cpu: 0, mem: 0, ready: '0/1', image: 'loki:2.9.4' },
    { name: 'kube-dns-6c8f-aa12b', ns: 'kube-system', node: 'ip-10-2-3-12', status: 'Running', restarts: 0, age: '64d', cpu: 12, mem: 64, ready: '1/1', image: 'coredns:1.11.1' },
    { name: 'session-cache-redis-0', ns: 'checkout', node: 'ip-10-2-4-09', status: 'Pending', restarts: 0, age: '12s', cpu: 0, mem: 0, ready: '0/1', image: 'redis:7.2-alpine' },
    { name: 'log-shipper-fluent-8j2k', ns: 'observability', node: 'ip-10-2-3-12', status: 'Running', restarts: 0, age: '32d', cpu: 22, mem: 84, ready: '1/1', image: 'fluent-bit:2.2.0' },
  ],
  'prod-us': [
    { name: 'auth-service-8c7-mn4kl', ns: 'auth', node: 'ip-10-9-1-12', status: 'Running', restarts: 0, age: '6d', cpu: 188, mem: 412, ready: '1/1', image: 'auth-service:v5.2.1' },
    { name: 'auth-service-8c7-pq9rt', ns: 'auth', node: 'ip-10-9-1-15', status: 'Running', restarts: 0, age: '6d', cpu: 192, mem: 421, ready: '1/1', image: 'auth-service:v5.2.1' },
    { name: 'auth-service-8c7-init-bb', ns: 'auth', node: 'ip-10-9-1-15', status: 'PodInitializing', restarts: 0, age: '22s', cpu: 12, mem: 48, ready: '0/1', image: 'auth-service:v5.2.1' },
    { name: 'checkout-api-7d4f8-xj2k', ns: 'checkout', node: 'ip-10-9-2-08', status: 'Running', restarts: 0, age: '4d', cpu: 134, mem: 366, ready: '1/1', image: 'checkout-api:v2.14.3' },
    { name: 'payments-api-9f7-bn4mq', ns: 'payments', node: 'ip-10-9-3-21', status: 'Running', restarts: 0, age: '8h', cpu: 224, mem: 528, ready: '1/1', image: 'payments-api:v4.0.1' },
    { name: 'payments-api-9f7-rt8wp', ns: 'payments', node: 'ip-10-9-3-23', status: 'Running', restarts: 0, age: '8h', cpu: 218, mem: 514, ready: '1/1', image: 'payments-api:v4.0.1' },
    { name: 'payments-api-9f7-term-7p', ns: 'payments', node: 'ip-10-9-3-21', status: 'Terminating', restarts: 0, age: '8h', cpu: 12, mem: 88, ready: '1/1', image: 'payments-api:v4.0.0' },
    { name: 'order-router-4b8-mk2lp', ns: 'checkout', node: 'ip-10-9-2-12', status: 'Running', restarts: 0, age: '2d', cpu: 76, mem: 192, ready: '1/1', image: 'order-router:v1.4.0' },
    { name: 'order-router-4b8-pull-12', ns: 'checkout', node: 'ip-10-9-2-12', status: 'ImagePullBackOff', restarts: 0, age: '3m', cpu: 0, mem: 0, ready: '0/1', image: 'order-router:v1.5.0-rc' },
    { name: 'nightly-export-job-9k4l', ns: 'payments', node: 'ip-10-9-3-23', status: 'Completed', restarts: 0, age: '8h', cpu: 0, mem: 0, ready: '0/1', image: 'payments-export:v1.0.0' },
    { name: 'prom-server-0', ns: 'observability', node: 'ip-10-9-6-01', status: 'Running', restarts: 0, age: '40d', cpu: 612, mem: 2560, ready: '2/2', image: 'prometheus:v2.51' },
    { name: 'kube-dns-6c8-cd34e', ns: 'kube-system', node: 'ip-10-9-1-12', status: 'Running', restarts: 0, age: '90d', cpu: 14, mem: 72, ready: '1/1', image: 'coredns:1.11.1' },
  ],
  'prod-ap': [
    { name: 'checkout-api-7d4-tx9km', ns: 'checkout', node: 'gke-prod-ap-pool-3', status: 'Unknown', restarts: 3, age: '2d', cpu: 0, mem: 0, ready: '0/1', image: 'checkout-api:v2.14.2' },
    { name: 'checkout-api-7d4-mz8lp', ns: 'checkout', node: 'gke-prod-ap-pool-2', status: 'Running', restarts: 1, age: '2d', cpu: 162, mem: 408, ready: '1/1', image: 'checkout-api:v2.14.2' },
    { name: 'payments-api-9f-jk8wp', ns: 'payments', node: 'gke-prod-ap-pool-2', status: 'Running', restarts: 0, age: '2d', cpu: 234, mem: 548, ready: '1/1', image: 'payments-api:v4.0.0' },
    { name: 'payments-worker-58-bn4', ns: 'payments', node: 'gke-prod-ap-pool-1', status: 'Error', restarts: 22, age: '1h', cpu: 0, mem: 0, ready: '0/1', image: 'payments-worker:v3.1.0' },
    { name: 'payments-worker-58-oom-9', ns: 'payments', node: 'gke-prod-ap-pool-1', status: 'OOMKilled', restarts: 5, age: '38m', cpu: 0, mem: 0, ready: '0/1', image: 'payments-worker:v3.1.0' },
    { name: 'cron-cleanup-1733-k4l', ns: 'default', node: 'gke-prod-ap-pool-2', status: 'Completed', restarts: 0, age: '2h', cpu: 0, mem: 0, ready: '0/1', image: 'busybox:1.36' },
    { name: 'kube-dns-6c8-zx14a', ns: 'kube-system', node: 'gke-prod-ap-pool-1', status: 'Running', restarts: 0, age: '40d', cpu: 12, mem: 64, ready: '1/1', image: 'coredns:1.11.1' },
  ],
  'staging': [
    { name: 'checkout-api-canary-1', ns: 'checkout', node: 'ip-10-3-1-12', status: 'Running', restarts: 0, age: '3h', cpu: 88, mem: 224, ready: '1/1', image: 'checkout-api:v2.15.0-rc1' },
    { name: 'checkout-api-canary-2', ns: 'checkout', node: 'ip-10-3-1-12', status: 'ContainerCreating', restarts: 0, age: '6s', cpu: 0, mem: 0, ready: '0/1', image: 'checkout-api:v2.15.0-rc1' },
    { name: 'payments-api-staging-1', ns: 'payments', node: 'ip-10-3-2-08', status: 'Running', restarts: 0, age: '1d', cpu: 142, mem: 312, ready: '1/1', image: 'payments-api:v4.1.0-rc2' },
    { name: 'qa-runner-7d-kk2lp', ns: 'qa', node: 'ip-10-3-2-12', status: 'Running', restarts: 0, age: '20m', cpu: 56, mem: 128, ready: '1/1', image: 'qa-runner:latest' },
    { name: 'qa-runner-7d-old-3p', ns: 'qa', node: 'ip-10-3-2-12', status: 'Completed', restarts: 0, age: '40m', cpu: 0, mem: 0, ready: '0/1', image: 'qa-runner:latest' },
  ],
  'dev': [
    { name: 'sandbox-jupyter-mxk', ns: 'sandbox', node: 'ip-10-4-1-08', status: 'Running', restarts: 0, age: '6h', cpu: 124, mem: 512, ready: '1/1', image: 'jupyter/datascience:latest' },
    { name: 'dev-postgres-0', ns: 'default', node: 'ip-10-4-1-09', status: 'Running', restarts: 0, age: '14d', cpu: 32, mem: 256, ready: '1/1', image: 'postgres:16' },
  ],
  'edge': [
    { name: 'cdn-cache-tx-2', ns: 'cdn', node: 'edge-tokyo-1', status: 'Running', restarts: 0, age: '7d', cpu: 184, mem: 412, ready: '1/1', image: 'varnish:7.5' },
    { name: 'cdn-cache-fr-1', ns: 'cdn', node: 'edge-paris-1', status: 'Running', restarts: 0, age: '7d', cpu: 162, mem: 388, ready: '1/1', image: 'varnish:7.5' },
    { name: 'cdn-cache-fr-init-2', ns: 'cdn', node: 'edge-paris-1', status: 'Init', restarts: 0, age: '18s', cpu: 4, mem: 16, ready: '0/1', image: 'varnish:7.5', initStep: '2/4' },
    { name: 'edge-router-3', ns: 'edge', node: 'edge-sfo-1', status: 'ImagePullBackOff', restarts: 0, age: '5m', cpu: 0, mem: 0, ready: '0/1', image: 'edge-router:v0.9.4-beta' },
    { name: 'edge-router-old-vx9k', ns: 'edge', node: 'edge-sfo-1', status: 'Terminating', restarts: 1, age: '7d', cpu: 22, mem: 84, ready: '1/1', image: 'edge-router:v0.9.3' },
  ],
};

const NODES_BY_CLUSTER = {
  'prod-eu': [
    { name: 'ip-10-2-3-12', role: 'worker', status: 'Ready', cpu: 0.71, mem: 0.78, pods: 32, age: '64d', kernel: '5.15', instance: 'm5.2xlarge' },
    { name: 'ip-10-2-3-14', role: 'worker', status: 'Ready', cpu: 0.62, mem: 0.69, pods: 28, age: '64d', kernel: '5.15', instance: 'm5.2xlarge' },
    { name: 'ip-10-2-4-08', role: 'worker', status: 'Ready', cpu: 0.55, mem: 0.71, pods: 24, age: '40d', kernel: '5.15', instance: 'm5.2xlarge' },
    { name: 'ip-10-2-4-09', role: 'worker', status: 'Ready', cpu: 0.48, mem: 0.62, pods: 22, age: '40d', kernel: '5.15', instance: 'm5.2xlarge' },
    { name: 'ip-10-2-5-21', role: 'worker', status: 'Ready', cpu: 0.83, mem: 0.74, pods: 36, age: '12d', kernel: '5.15', instance: 'm5.4xlarge' },
    { name: 'ip-10-2-5-23', role: 'worker', status: 'Ready', cpu: 0.72, mem: 0.68, pods: 30, age: '12d', kernel: '5.15', instance: 'm5.4xlarge' },
    { name: 'ip-10-2-6-44', role: 'worker', status: 'Ready', cpu: 0.41, mem: 0.86, pods: 14, age: '32d', kernel: '5.15', instance: 'r5.2xlarge' },
    { name: 'ip-10-2-6-46', role: 'worker', status: 'Ready', cpu: 0.38, mem: 0.71, pods: 12, age: '3d', kernel: '5.15', instance: 'r5.2xlarge' },
    { name: 'ip-10-2-1-04', role: 'control-plane', status: 'Ready', cpu: 0.22, mem: 0.41, pods: 6, age: '180d', kernel: '5.15', instance: 'managed' },
  ],
  'prod-us': [
    { name: 'ip-10-9-1-12', role: 'worker', status: 'Ready', cpu: 0.81, mem: 0.74, pods: 38, age: '90d', kernel: '5.15', instance: 'm5.4xlarge' },
    { name: 'ip-10-9-1-15', role: 'worker', status: 'Ready', cpu: 0.74, mem: 0.68, pods: 34, age: '90d', kernel: '5.15', instance: 'm5.4xlarge' },
    { name: 'ip-10-9-2-08', role: 'worker', status: 'Ready', cpu: 0.62, mem: 0.71, pods: 28, age: '40d', kernel: '5.15', instance: 'm5.2xlarge' },
    { name: 'ip-10-9-2-12', role: 'worker', status: 'Ready', cpu: 0.51, mem: 0.62, pods: 24, age: '20d', kernel: '5.15', instance: 'm5.2xlarge' },
    { name: 'ip-10-9-3-21', role: 'worker', status: 'Ready', cpu: 0.88, mem: 0.74, pods: 42, age: '8d', kernel: '5.15', instance: 'm5.4xlarge' },
    { name: 'ip-10-9-3-23', role: 'worker', status: 'Ready', cpu: 0.78, mem: 0.71, pods: 36, age: '8d', kernel: '5.15', instance: 'm5.4xlarge' },
    { name: 'ip-10-9-6-01', role: 'worker', status: 'Ready', cpu: 0.52, mem: 0.91, pods: 18, age: '40d', kernel: '5.15', instance: 'r5.4xlarge' },
  ],
  'prod-ap': [
    { name: 'gke-prod-ap-pool-1', role: 'worker', status: 'Ready', cpu: 0.91, mem: 0.88, pods: 42, age: '40d', kernel: '5.15', instance: 'n2-standard-8' },
    { name: 'gke-prod-ap-pool-2', role: 'worker', status: 'Ready', cpu: 0.82, mem: 0.79, pods: 38, age: '40d', kernel: '5.15', instance: 'n2-standard-8' },
    { name: 'gke-prod-ap-pool-3', role: 'worker', status: 'NotReady', cpu: 0, mem: 0, pods: 0, age: '40d', kernel: '5.15', instance: 'n2-standard-8' },
  ],
  'staging': [
    { name: 'ip-10-3-1-12', role: 'worker', status: 'Ready', cpu: 0.32, mem: 0.41, pods: 16, age: '40d', kernel: '5.15', instance: 'm5.large' },
    { name: 'ip-10-3-2-08', role: 'worker', status: 'Ready', cpu: 0.41, mem: 0.48, pods: 18, age: '40d', kernel: '5.15', instance: 'm5.large' },
    { name: 'ip-10-3-2-12', role: 'worker', status: 'Ready', cpu: 0.28, mem: 0.34, pods: 12, age: '40d', kernel: '5.15', instance: 'm5.large' },
  ],
  'dev': [
    { name: 'ip-10-4-1-08', role: 'worker', status: 'Ready', cpu: 0.22, mem: 0.34, pods: 12, age: '90d', kernel: '5.15', instance: 't3.large' },
    { name: 'ip-10-4-1-09', role: 'worker', status: 'Ready', cpu: 0.18, mem: 0.28, pods: 10, age: '90d', kernel: '5.15', instance: 't3.large' },
  ],
  'edge': [
    { name: 'edge-tokyo-1', role: 'worker', status: 'Ready', cpu: 0.42, mem: 0.51, pods: 8, age: '120d', kernel: '5.10', instance: 'bare-metal' },
    { name: 'edge-paris-1', role: 'worker', status: 'Ready', cpu: 0.38, mem: 0.48, pods: 8, age: '120d', kernel: '5.10', instance: 'bare-metal' },
    { name: 'edge-sfo-1', role: 'worker', status: 'Ready', cpu: 0.51, mem: 0.61, pods: 10, age: '120d', kernel: '5.10', instance: 'bare-metal' },
  ],
};

const CONFIGMAPS_BY_CLUSTER = {
  'prod-eu': [
    { name: 'checkout-config', ns: 'checkout', keys: 12, age: '4d', size: '4.2 KB' },
    { name: 'payments-feature-flags', ns: 'payments', keys: 28, age: '6h', size: '2.1 KB' },
    { name: 'fraud-rules', ns: 'payments', keys: 8, age: '2d', size: '14 KB' },
    { name: 'grafana-dashboards', ns: 'observability', keys: 42, age: '12d', size: '180 KB' },
    { name: 'prom-rules', ns: 'observability', keys: 18, age: '32d', size: '22 KB' },
    { name: 'coredns', ns: 'kube-system', keys: 4, age: '64d', size: '0.8 KB' },
  ],
  'prod-us': [
    { name: 'auth-jwks', ns: 'auth', keys: 4, age: '12d', size: '2.4 KB' },
    { name: 'checkout-config', ns: 'checkout', keys: 12, age: '4d', size: '4.2 KB' },
    { name: 'payments-feature-flags', ns: 'payments', keys: 28, age: '6h', size: '2.1 KB' },
    { name: 'order-routing', ns: 'checkout', keys: 6, age: '2d', size: '1.4 KB' },
  ],
  'prod-ap': [
    { name: 'checkout-config', ns: 'checkout', keys: 12, age: '2d', size: '4.2 KB' },
    { name: 'payments-feature-flags', ns: 'payments', keys: 26, age: '2d', size: '2.0 KB' },
  ],
  'staging': [
    { name: 'checkout-canary-config', ns: 'checkout', keys: 14, age: '3h', size: '4.4 KB' },
    { name: 'qa-fixtures', ns: 'qa', keys: 32, age: '1d', size: '88 KB' },
  ],
  'dev': [
    { name: 'sandbox-env', ns: 'sandbox', keys: 8, age: '6h', size: '1.2 KB' },
  ],
  'edge': [
    { name: 'cdn-routes', ns: 'cdn', keys: 24, age: '7d', size: '12 KB' },
    { name: 'edge-rules', ns: 'edge', keys: 18, age: '7d', size: '8.4 KB' },
  ],
};

// Pretty-print helpers
const fmtPct = (x) => Math.round(x * 100) + '%';
const fmtMi = (mb) => mb >= 1024 ? (mb / 1024).toFixed(1) + ' Gi' : mb + ' Mi';

// Status color tokens (Tailwind-ish but inline so we can swap themes)
// 4 buckets: healthy (green) / pending (amber) / failure (red) / neutral (slate) / blue (info / transient)
function statusColor(s, theme = 'light') {
  const dark = theme === 'dark';
  const green  = { fg: dark ? '#34d399' : '#047857', bg: dark ? 'rgba(16,185,129,0.16)' : '#d1fae5', dot: '#10b981' };
  const amber  = { fg: dark ? '#fbbf24' : '#92400e', bg: dark ? 'rgba(251,191,36,0.16)' : '#fef3c7', dot: '#f59e0b' };
  const red    = { fg: dark ? '#fb7185' : '#9f1239', bg: dark ? 'rgba(244,63,94,0.16)' : '#ffe4e6', dot: '#f43f5e' };
  const blue   = { fg: dark ? '#60a5fa' : '#1d4ed8', bg: dark ? 'rgba(96,165,250,0.16)' : '#dbeafe', dot: '#3b82f6' };
  const slate  = { fg: dark ? '#94a3b8' : '#475569', bg: dark ? 'rgba(148,163,184,0.16)' : '#e2e8f0', dot: '#64748b' };
  const violet = { fg: dark ? '#c4b5fd' : '#5b21b6', bg: dark ? 'rgba(167,139,250,0.16)' : '#ede9fe', dot: '#8b5cf6' };

  if (['Running', 'Ready', 'healthy'].includes(s)) return green;
  if (['Completed', 'Succeeded'].includes(s)) return violet;
  if (['Pending', 'warning', 'degraded'].includes(s)) return amber;
  if (['ContainerCreating', 'PodInitializing', 'Init'].includes(s)) return blue;
  if (['Terminating'].includes(s)) return slate;
  if (['CrashLoopBackOff', 'Error', 'ImagePullBackOff', 'NotReady', 'OOMKilled', 'Evicted', 'ErrImagePull'].includes(s)) return red;
  if (['Unknown'].includes(s)) return slate;
  return slate;
}

// Whether a status implies the pod is in a transient/animating phase (used for
// pulse/spinner affordances in the UI).
function statusIsTransient(s) {
  return ['ContainerCreating', 'PodInitializing', 'Init', 'Pending', 'Terminating'].includes(s);
}

// ─── Container topology synthesis ──────────────────────────────────────────
// Each pod gets a `containers` array describing its init containers, the main
// container, and any sidecars, with a per-container status. Topology is derived
// deterministically from the pod's name so it stays stable across renders.
//
// Status logic:
//   Running       → all containers Running
//   Init          → init[0..n-1] Running, init[step] Running, rest Waiting; main+sidecars Waiting
//   PodInitializing → all init Completed, main + sidecars ContainerCreating
//   ContainerCreating → init Completed, main+sidecars ContainerCreating
//   Pending       → all Waiting
//   Terminating   → all Terminating
//   Completed     → all Completed
//   CrashLoopBackOff/Error → main CrashLoopBackOff, sidecars Running, init Completed
//   OOMKilled     → main OOMKilled, others Running/Completed
//   ImagePullBackOff/ErrImagePull → main ImagePullBackOff, others Waiting
//   Evicted/Unknown → all match
const SIDECAR_KINDS = {
  // Common sidecars by image-prefix association
  api:     [{ name: 'istio-proxy', image: 'istio/proxyv2:1.20' }, { name: 'log-shipper', image: 'fluent-bit:2.2' }],
  worker:  [{ name: 'istio-proxy', image: 'istio/proxyv2:1.20' }],
  service: [{ name: 'istio-proxy', image: 'istio/proxyv2:1.20' }, { name: 'otel-agent', image: 'otel/collector:0.96' }],
  cache:   [{ name: 'metrics-exporter', image: 'redis-exporter:1.55' }],
  router:  [{ name: 'istio-proxy', image: 'istio/proxyv2:1.20' }],
  default: [],
};

function _sidecarsFor(pod) {
  const n = pod.name;
  if (n.includes('-api') || n.includes('auth-')) return SIDECAR_KINDS.api;
  if (n.includes('worker')) return SIDECAR_KINDS.worker;
  if (n.includes('router')) return SIDECAR_KINDS.router;
  if (n.includes('redis') || n.includes('cache')) return SIDECAR_KINDS.cache;
  if (n.includes('grafana') || n.includes('loki') || n.includes('prom')) return SIDECAR_KINDS.service;
  if (n.includes('dns') || n.includes('coredns')) return [];
  if (n.includes('jupyter') || n.includes('postgres') || n.includes('varnish')) return [];
  return SIDECAR_KINDS.default;
}

function _initsFor(pod) {
  const n = pod.name;
  // Pods with explicit init signals get more init steps
  if (n.includes('-api') || n.includes('auth-')) return [
    { name: 'wait-for-db', image: 'busybox:1.36' },
    { name: 'run-migrations', image: 'migrate:v4' },
  ];
  if (n.includes('payments-api')) return [
    { name: 'wait-for-db', image: 'busybox:1.36' },
    { name: 'run-migrations', image: 'migrate:v4' },
    { name: 'load-secrets', image: 'vault-agent:1.15' },
  ];
  if (n.includes('checkout')) return [{ name: 'wait-for-cache', image: 'busybox:1.36' }];
  if (n.includes('worker')) return [{ name: 'wait-for-broker', image: 'busybox:1.36' }];
  return [];
}

function buildContainers(pod) {
  const inits = _initsFor(pod);
  const sidecars = _sidecarsFor(pod);
  const mainName = pod.name.split('-').slice(0, 2).join('-') || 'app';
  const main = { name: mainName, image: pod.image, kind: 'main' };

  const s = pod.status;
  const list = [];

  // Helper: assign per-container status
  const push = (c, status, extra = {}) => list.push({ ...c, kind: c.kind || 'init', status, ...extra });

  if (s === 'Running') {
    inits.forEach(c => push({ ...c, kind: 'init' }, 'Completed'));
    push(main, 'Running', { restarts: pod.restarts || 0, ready: true });
    sidecars.forEach(c => push({ ...c, kind: 'sidecar' }, 'Running', { ready: true }));
  } else if (s === 'Init') {
    // initStep like "1/3" — index of currently-running init container
    const [cur, total] = (pod.initStep || '1/' + Math.max(1, inits.length)).split('/').map(Number);
    const used = inits.length ? inits : [{ name: 'init', image: 'busybox:1.36' }];
    used.forEach((c, i) => {
      const st = i < cur - 1 ? 'Completed' : (i === cur - 1 ? 'Running' : 'Waiting');
      push({ ...c, kind: 'init' }, st);
    });
    push(main, 'Waiting');
    sidecars.forEach(c => push({ ...c, kind: 'sidecar' }, 'Waiting'));
  } else if (s === 'PodInitializing' || s === 'ContainerCreating') {
    inits.forEach(c => push({ ...c, kind: 'init' }, 'Completed'));
    push(main, 'ContainerCreating');
    sidecars.forEach(c => push({ ...c, kind: 'sidecar' }, 'ContainerCreating'));
  } else if (s === 'Pending') {
    inits.forEach(c => push({ ...c, kind: 'init' }, 'Waiting'));
    push(main, 'Waiting');
    sidecars.forEach(c => push({ ...c, kind: 'sidecar' }, 'Waiting'));
  } else if (s === 'Terminating') {
    inits.forEach(c => push({ ...c, kind: 'init' }, 'Completed'));
    push(main, 'Terminating', { restarts: pod.restarts || 0 });
    sidecars.forEach(c => push({ ...c, kind: 'sidecar' }, 'Terminating'));
  } else if (s === 'Completed' || s === 'Succeeded') {
    inits.forEach(c => push({ ...c, kind: 'init' }, 'Completed'));
    push(main, 'Completed');
    sidecars.forEach(c => push({ ...c, kind: 'sidecar' }, 'Completed'));
  } else if (s === 'CrashLoopBackOff' || s === 'Error') {
    inits.forEach(c => push({ ...c, kind: 'init' }, 'Completed'));
    push(main, s, { restarts: pod.restarts || 0 });
    // sidecars often keep running while main crashes
    sidecars.forEach(c => push({ ...c, kind: 'sidecar' }, 'Running'));
  } else if (s === 'OOMKilled') {
    inits.forEach(c => push({ ...c, kind: 'init' }, 'Completed'));
    push(main, 'OOMKilled', { restarts: pod.restarts || 0 });
    sidecars.forEach(c => push({ ...c, kind: 'sidecar' }, 'Running'));
  } else if (s === 'ImagePullBackOff' || s === 'ErrImagePull') {
    inits.forEach(c => push({ ...c, kind: 'init' }, 'Waiting'));
    push(main, s);
    sidecars.forEach(c => push({ ...c, kind: 'sidecar' }, 'Waiting'));
  } else if (s === 'Evicted') {
    inits.forEach(c => push({ ...c, kind: 'init' }, 'Evicted'));
    push(main, 'Evicted');
    sidecars.forEach(c => push({ ...c, kind: 'sidecar' }, 'Evicted'));
  } else if (s === 'Unknown') {
    inits.forEach(c => push({ ...c, kind: 'init' }, 'Unknown'));
    push(main, 'Unknown');
    sidecars.forEach(c => push({ ...c, kind: 'sidecar' }, 'Unknown'));
  } else {
    // fallback
    inits.forEach(c => push({ ...c, kind: 'init' }, 'Completed'));
    push(main, s);
    sidecars.forEach(c => push({ ...c, kind: 'sidecar' }, 'Running'));
  }
  return list;
}

// Decorate every pod in PODS_BY_CLUSTER with a `containers` array (memoized).
Object.keys(PODS_BY_CLUSTER).forEach(k => {
  PODS_BY_CLUSTER[k] = PODS_BY_CLUSTER[k].map(p => ({ ...p, containers: buildContainers(p) }));
});

Object.assign(window, {
  CLUSTERS, PODS_BY_CLUSTER, NODES_BY_CLUSTER, CONFIGMAPS_BY_CLUSTER,
  fmtPct, fmtMi, statusColor, statusIsTransient, buildContainers,
});
