// Starter manifests for the dock's YAML scratchpad. Each template is a
// fully-valid object operators can `kubectl apply -f` as-is, with names
// generic enough to edit before applying. Grouped by category so the
// picker mirrors how operators think ("new Deployment", "new Service").

export type YamlTemplateCategory =
  | "Workloads"
  | "Network"
  | "Config"
  | "Storage"
  | "RBAC"
  | "Policy";

export type YamlTemplate = {
  id: string;
  label: string;
  kind: string;
  category: YamlTemplateCategory;
  yaml: string;
};

const DEPLOYMENT = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: hello-world
  namespace: default
  labels:
    app: hello-world
spec:
  replicas: 3
  selector:
    matchLabels:
      app: hello-world
  template:
    metadata:
      labels:
        app: hello-world
    spec:
      containers:
        - name: hello
          image: nginx:1.27
          ports:
            - containerPort: 80
`;

const POD = `apiVersion: v1
kind: Pod
metadata:
  name: hello-pod
  namespace: default
  labels:
    app: hello-pod
spec:
  containers:
    - name: hello
      image: nginx:1.27
      ports:
        - containerPort: 80
      resources:
        requests:
          cpu: 50m
          memory: 64Mi
        limits:
          cpu: 200m
          memory: 256Mi
`;

const STATEFULSET = `apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: hello-sts
  namespace: default
spec:
  serviceName: hello-sts
  replicas: 2
  selector:
    matchLabels:
      app: hello-sts
  template:
    metadata:
      labels:
        app: hello-sts
    spec:
      containers:
        - name: hello
          image: nginx:1.27
          ports:
            - containerPort: 80
              name: web
          volumeMounts:
            - name: data
              mountPath: /usr/share/nginx/html
  volumeClaimTemplates:
    - metadata:
        name: data
      spec:
        accessModes: ["ReadWriteOnce"]
        resources:
          requests:
            storage: 1Gi
`;

const DAEMONSET = `apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: hello-ds
  namespace: default
spec:
  selector:
    matchLabels:
      app: hello-ds
  template:
    metadata:
      labels:
        app: hello-ds
    spec:
      containers:
        - name: hello
          image: nginx:1.27
          resources:
            requests:
              cpu: 50m
              memory: 64Mi
`;

const JOB = `apiVersion: batch/v1
kind: Job
metadata:
  name: hello-job
  namespace: default
spec:
  backoffLimit: 4
  template:
    spec:
      restartPolicy: OnFailure
      containers:
        - name: hello
          image: busybox:1.36
          command: ["sh", "-c", "echo hello && sleep 5"]
`;

const CRONJOB = `apiVersion: batch/v1
kind: CronJob
metadata:
  name: hello-cron
  namespace: default
spec:
  schedule: "*/5 * * * *"
  successfulJobsHistoryLimit: 3
  failedJobsHistoryLimit: 1
  jobTemplate:
    spec:
      template:
        spec:
          restartPolicy: OnFailure
          containers:
            - name: hello
              image: busybox:1.36
              command: ["sh", "-c", "date && echo hello"]
`;

const SERVICE = `apiVersion: v1
kind: Service
metadata:
  name: hello-world
  namespace: default
spec:
  type: ClusterIP
  selector:
    app: hello-world
  ports:
    - name: http
      port: 80
      targetPort: 80
      protocol: TCP
`;

const INGRESS = `apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: hello-world
  namespace: default
spec:
  ingressClassName: nginx
  rules:
    - host: hello.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: hello-world
                port:
                  number: 80
`;

const NETWORK_POLICY = `apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny-ingress
  namespace: default
spec:
  podSelector: {}
  policyTypes:
    - Ingress
`;

const CONFIG_MAP = `apiVersion: v1
kind: ConfigMap
metadata:
  name: hello-config
  namespace: default
data:
  app.properties: |
    greeting=hello
    log.level=info
  feature.flags: "alpha,beta"
`;

const SECRET = `apiVersion: v1
kind: Secret
metadata:
  name: hello-secret
  namespace: default
type: Opaque
stringData:
  username: admin
  password: change-me
`;

const SERVICE_ACCOUNT = `apiVersion: v1
kind: ServiceAccount
metadata:
  name: hello-sa
  namespace: default
`;

const PVC = `apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: hello-pvc
  namespace: default
spec:
  accessModes: ["ReadWriteOnce"]
  resources:
    requests:
      storage: 1Gi
`;

const HPA = `apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: hello-world
  namespace: default
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: hello-world
  minReplicas: 1
  maxReplicas: 10
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 60
`;

const ROLE = `apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: hello-role
  namespace: default
rules:
  - apiGroups: [""]
    resources: ["pods", "pods/log"]
    verbs: ["get", "list", "watch"]
`;

const ROLE_BINDING = `apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: hello-rolebinding
  namespace: default
subjects:
  - kind: ServiceAccount
    name: hello-sa
    namespace: default
roleRef:
  kind: Role
  name: hello-role
  apiGroup: rbac.authorization.k8s.io
`;

const CLUSTER_ROLE = `apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: hello-clusterrole
rules:
  - apiGroups: [""]
    resources: ["nodes"]
    verbs: ["get", "list", "watch"]
`;

const CLUSTER_ROLE_BINDING = `apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: hello-clusterrolebinding
subjects:
  - kind: ServiceAccount
    name: hello-sa
    namespace: default
roleRef:
  kind: ClusterRole
  name: hello-clusterrole
  apiGroup: rbac.authorization.k8s.io
`;

const NAMESPACE = `apiVersion: v1
kind: Namespace
metadata:
  name: hello-namespace
`;

export const YAML_TEMPLATES: YamlTemplate[] = [
  { id: "deployment", label: "Deployment", kind: "Deployment", category: "Workloads", yaml: DEPLOYMENT },
  { id: "pod", label: "Pod", kind: "Pod", category: "Workloads", yaml: POD },
  { id: "statefulset", label: "StatefulSet", kind: "StatefulSet", category: "Workloads", yaml: STATEFULSET },
  { id: "daemonset", label: "DaemonSet", kind: "DaemonSet", category: "Workloads", yaml: DAEMONSET },
  { id: "job", label: "Job", kind: "Job", category: "Workloads", yaml: JOB },
  { id: "cronjob", label: "CronJob", kind: "CronJob", category: "Workloads", yaml: CRONJOB },
  { id: "hpa", label: "HorizontalPodAutoscaler", kind: "HorizontalPodAutoscaler", category: "Workloads", yaml: HPA },
  { id: "service", label: "Service (ClusterIP)", kind: "Service", category: "Network", yaml: SERVICE },
  { id: "ingress", label: "Ingress", kind: "Ingress", category: "Network", yaml: INGRESS },
  { id: "networkpolicy", label: "NetworkPolicy (deny ingress)", kind: "NetworkPolicy", category: "Policy", yaml: NETWORK_POLICY },
  { id: "configmap", label: "ConfigMap", kind: "ConfigMap", category: "Config", yaml: CONFIG_MAP },
  { id: "secret", label: "Secret", kind: "Secret", category: "Config", yaml: SECRET },
  { id: "namespace", label: "Namespace", kind: "Namespace", category: "Config", yaml: NAMESPACE },
  { id: "pvc", label: "PersistentVolumeClaim", kind: "PersistentVolumeClaim", category: "Storage", yaml: PVC },
  { id: "serviceaccount", label: "ServiceAccount", kind: "ServiceAccount", category: "RBAC", yaml: SERVICE_ACCOUNT },
  { id: "role", label: "Role", kind: "Role", category: "RBAC", yaml: ROLE },
  { id: "rolebinding", label: "RoleBinding", kind: "RoleBinding", category: "RBAC", yaml: ROLE_BINDING },
  { id: "clusterrole", label: "ClusterRole", kind: "ClusterRole", category: "RBAC", yaml: CLUSTER_ROLE },
  { id: "clusterrolebinding", label: "ClusterRoleBinding", kind: "ClusterRoleBinding", category: "RBAC", yaml: CLUSTER_ROLE_BINDING },
];

export const DEFAULT_YAML_TEMPLATE_ID = "deployment";

export function getYamlTemplate(id: string): YamlTemplate {
  return (
    YAML_TEMPLATES.find((tpl) => tpl.id === id) ??
    YAML_TEMPLATES.find((tpl) => tpl.id === DEFAULT_YAML_TEMPLATE_ID)!
  );
}

export const YAML_TEMPLATE_CATEGORIES: YamlTemplateCategory[] = [
  "Workloads",
  "Network",
  "Config",
  "Storage",
  "RBAC",
  "Policy",
];
