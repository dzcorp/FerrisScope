// Helmsman v2 — bottom dock
// A bottom-pinned panel that hosts terminal sessions and YAML editor scratchpads
// as tabs. Resizable vertically via the top edge; can be minimized to a stub.

const HV2_MONO_DOCK = '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace';

// ── Public API ─────────────────────────────────────────────────────────────
// Tabs are stored as: { id, kind: 'terminal' | 'yaml', title, state }
// Where state holds tab-local data (terminal lines, yaml content, etc).

let _tabIdSeq = 1;
const newTabId = (kind) => `${kind}-${_tabIdSeq++}`;

function makeTerminalTab(cluster, ns) {
  return {
    id: newTabId('term'),
    kind: 'terminal',
    title: `kubectl@${cluster.name.split(' ')[0].toLowerCase()}`,
    state: {
      history: [], // array of { kind: 'cmd' | 'out' | 'err' | 'info', text }
      input: '',
      cmdLog: [], // up-arrow recall
      cmdIdx: -1,
      // canned welcome
      booted: false,
    },
  };
}

function makeYamlTab(cluster, ns) {
  return {
    id: newTabId('yaml'),
    kind: 'yaml',
    title: 'manifest.yaml',
    state: {
      content: YAML_TEMPLATES.deployment.body,
      template: 'deployment',
      lastAction: null, // { kind: 'apply' | 'dryrun' | 'validate', result, ts }
    },
  };
}

// ── Dock shell ─────────────────────────────────────────────────────────────
function HV2Dock({ t, theme, cluster, activeNs, tabs, setTabs, activeTabId, setActiveTabId,
                   minimized, setMinimized, onClose }) {
  const [height, setHeight] = React.useState(320);
  const dragRef = React.useRef(null);

  const onDragStart = (e) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = height;
    const onMove = (ev) => {
      const dy = startY - ev.clientY;
      const next = Math.max(180, Math.min(window.innerHeight - 200, startH + dy));
      setHeight(next);
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const activeTab = tabs.find(tab => tab.id === activeTabId) || tabs[0];

  const updateTabState = (id, patch) => {
    setTabs(prev => prev.map(tab => tab.id === id ? { ...tab, state: { ...tab.state, ...patch } } : tab));
  };
  const updateTab = (id, patch) => {
    setTabs(prev => prev.map(tab => tab.id === id ? { ...tab, ...patch } : tab));
  };

  const closeTab = (id) => {
    setTabs(prev => {
      const next = prev.filter(tab => tab.id !== id);
      if (next.length === 0) { onClose(); return next; }
      if (activeTabId === id) setActiveTabId(next[next.length - 1].id);
      return next;
    });
  };

  const addTerminal = () => {
    const tab = makeTerminalTab(cluster, activeNs);
    setTabs(prev => [...prev, tab]);
    setActiveTabId(tab.id);
  };
  const addYaml = () => {
    const tab = makeYamlTab(cluster, activeNs);
    setTabs(prev => [...prev, tab]);
    setActiveTabId(tab.id);
  };

  // namespace summary string
  const nsLabel = !activeNs || activeNs.size === 0
    ? 'all'
    : activeNs.size === 1 ? [...activeNs][0] : `${activeNs.size} ns`;

  if (minimized) {
    return (
      <div style={{
        position: 'absolute', left: 0, right: 0, bottom: 0,
        background: t.headerAlt, borderTop: `1px solid ${t.border}`,
        padding: '6px 14px', display: 'flex', alignItems: 'center', gap: 10,
        zIndex: 18, fontSize: 12,
      }}>
        <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke={t.textDim} strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 3l3 3-3 3 M7 9h4"/>
        </svg>
        <span style={{ color: t.textDim, fontWeight: 500 }}>Dock</span>
        <span style={{ color: t.textMuted }}>·</span>
        <span style={{ color: t.textMuted }}>{tabs.length} tab{tabs.length === 1 ? '' : 's'}</span>
        <div style={{ flex: 1 }} />
        <button onClick={() => setMinimized(false)} style={btnSubtle(t)}>Restore</button>
        <button onClick={onClose} style={btnSubtle(t)} title="Close dock">
          <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><path d="M3 3l8 8M11 3l-8 8"/></svg>
        </button>
      </div>
    );
  }

  return (
    <div style={{
      position: 'absolute', left: 0, right: 0, bottom: 0,
      height,
      display: 'flex', flexDirection: 'column',
      background: t.surface,
      borderTop: `1px solid ${t.border}`,
      boxShadow: theme === 'dark' ? '0 -8px 24px rgba(0,0,0,0.4)' : '0 -8px 24px rgba(15,20,30,0.08)',
      zIndex: 18,
    }}>
      {/* drag handle */}
      <div ref={dragRef} onMouseDown={onDragStart}
        style={{
          height: 6, marginTop: -3, cursor: 'ns-resize',
          position: 'absolute', left: 0, right: 0, top: 0, zIndex: 2,
        }} />

      {/* tab bar */}
      <div style={{
        display: 'flex', alignItems: 'stretch',
        background: t.headerAlt, borderBottom: `1px solid ${t.border}`,
        flexShrink: 0,
      }}>
        <div style={{ display: 'flex', alignItems: 'stretch', flex: 1, minWidth: 0, overflowX: 'auto' }}>
          {tabs.map(tab => {
            const isActive = tab.id === activeTabId;
            return (
              <div key={tab.id}
                onClick={() => setActiveTabId(tab.id)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 7,
                  padding: '0 10px 0 12px', height: 34,
                  borderRight: `1px solid ${t.borderSoft}`,
                  background: isActive ? t.surface : 'transparent',
                  borderBottom: isActive ? `2px solid ${t.accent}` : '2px solid transparent',
                  marginBottom: -1,
                  cursor: 'pointer', minWidth: 0,
                  fontSize: 11.5, color: isActive ? t.text : t.textDim,
                  fontWeight: isActive ? 600 : 500,
                }}>
                <DockTabIcon kind={tab.kind} color={isActive ? t.accent : t.textMuted} />
                <span style={{ fontFamily: HV2_MONO_DOCK, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 180 }}>{tab.title}</span>
                <button onClick={(e) => { e.stopPropagation(); closeTab(tab.id); }}
                  title="Close tab"
                  style={{
                    border: 'none', background: 'transparent', padding: 2, marginLeft: 2,
                    cursor: 'pointer', color: t.textMuted, display: 'flex',
                    borderRadius: 3,
                  }}
                  onMouseEnter={e => e.currentTarget.style.background = t.hover}
                  onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
                  <svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><path d="M2 2l6 6M8 2l-6 6"/></svg>
                </button>
              </div>
            );
          })}
        </div>

        {/* right-side dock controls */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '0 8px 0 6px', borderLeft: `1px solid ${t.borderSoft}`, flexShrink: 0 }}>
          <button onClick={addTerminal} title="New terminal" style={dockIconBtn(t)}>
            <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 3l3 3-3 3 M7 9h4"/>
            </svg>
          </button>
          <button onClick={addYaml} title="New YAML" style={dockIconBtn(t)}>
            <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M2 7l2-2-2-2M12 3l-2 2 2 2M6 11l3-8" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </button>
          <div style={{ width: 1, height: 16, background: t.borderSoft, margin: '0 3px' }} />
          {/* Context chip */}
          <div style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            padding: '3px 8px', borderRadius: 4,
            background: t.chip, fontSize: 10.5, color: t.textDim,
            fontFamily: HV2_MONO_DOCK,
          }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#10b981' }} />
            {cluster.name}
            <span style={{ color: t.textMuted }}>·</span>
            <span style={{ color: t.text }}>{nsLabel}</span>
          </div>
          <div style={{ width: 1, height: 16, background: t.borderSoft, margin: '0 3px' }} />
          <button onClick={() => setMinimized(true)} title="Minimize" style={dockIconBtn(t)}>
            <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><path d="M2 9h8"/></svg>
          </button>
          <button onClick={onClose} title="Close dock" style={dockIconBtn(t)}>
            <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><path d="M3 3l8 8M11 3l-8 8"/></svg>
          </button>
        </div>
      </div>

      {/* tab body */}
      <div style={{ flex: 1, minHeight: 0, position: 'relative', overflow: 'hidden' }}>
        {activeTab && activeTab.kind === 'terminal' && (
          <DockTerminal t={t} theme={theme} cluster={cluster} activeNs={activeNs}
            tab={activeTab} updateTabState={(p) => updateTabState(activeTab.id, p)}
            updateTab={(p) => updateTab(activeTab.id, p)} />
        )}
        {activeTab && activeTab.kind === 'yaml' && (
          <DockYaml t={t} theme={theme} cluster={cluster} activeNs={activeNs}
            tab={activeTab} updateTabState={(p) => updateTabState(activeTab.id, p)}
            updateTab={(p) => updateTab(activeTab.id, p)} />
        )}
      </div>
    </div>
  );
}

function DockTabIcon({ kind, color }) {
  if (kind === 'terminal') return (
    <svg width="11" height="11" viewBox="0 0 14 14" fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 3l3 3-3 3 M7 9h4"/>
    </svg>
  );
  return (
    <svg width="11" height="11" viewBox="0 0 14 14" fill="none" stroke={color} strokeWidth="1.5">
      <path d="M2 7l2-2-2-2M12 3l-2 2 2 2M6 11l3-8" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}

function dockIconBtn(t) {
  return {
    border: 'none', background: 'transparent', cursor: 'pointer',
    color: t.textDim, padding: 5, borderRadius: 4, display: 'flex', alignItems: 'center', justifyContent: 'center',
  };
}
function btnSubtle(t) {
  return {
    border: `1px solid ${t.border}`, background: t.surface, color: t.text,
    padding: '4px 10px', borderRadius: 5, fontSize: 11.5, cursor: 'pointer', fontFamily: 'inherit',
  };
}

// ── Terminal tab ────────────────────────────────────────────────────────────
function DockTerminal({ t, theme, cluster, activeNs, tab, updateTabState }) {
  const { history, input, cmdLog, cmdIdx, booted } = tab.state;
  const inputRef = React.useRef(null);
  const scrollRef = React.useRef(null);

  // Boot banner once.
  React.useEffect(() => {
    if (booted) return;
    const ns = activeNs && activeNs.size === 1 ? [...activeNs][0] : 'default';
    const lines = [
      { kind: 'info', text: `Switched to context "${cluster.id}".` },
      { kind: 'info', text: `Namespace: ${ns}  ·  Server version: ${cluster.version}` },
      { kind: 'info', text: 'Type a command, or try: kubectl get pods · kubectl get nodes · help' },
    ];
    updateTabState({ history: lines, booted: true });
  }, [booted, cluster.id]);

  // Auto-scroll to bottom on history change
  React.useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [history.length]);

  const ns = activeNs && activeNs.size === 1 ? [...activeNs][0] : 'default';
  const promptStr = `${cluster.id}:${ns}$ `;

  const submit = () => {
    const cmd = input.trim();
    if (!cmd) return;
    const out = runCannedCommand(cmd, cluster, activeNs);
    const newHistory = [
      ...history,
      { kind: 'cmd', text: promptStr + cmd },
      ...out,
    ];
    updateTabState({
      history: newHistory,
      input: '',
      cmdLog: [...cmdLog, cmd],
      cmdIdx: -1,
    });
  };

  const onKey = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); submit(); return; }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (cmdLog.length === 0) return;
      const idx = cmdIdx === -1 ? cmdLog.length - 1 : Math.max(0, cmdIdx - 1);
      updateTabState({ cmdIdx: idx, input: cmdLog[idx] });
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (cmdIdx === -1) return;
      const idx = cmdIdx + 1;
      if (idx >= cmdLog.length) {
        updateTabState({ cmdIdx: -1, input: '' });
      } else {
        updateTabState({ cmdIdx: idx, input: cmdLog[idx] });
      }
      return;
    }
    if (e.key === 'l' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      updateTabState({ history: [] });
    }
  };

  const colorFor = (kind) => {
    if (kind === 'cmd') return theme === 'dark' ? '#f8fafc' : '#0f172a';
    if (kind === 'err') return '#f43f5e';
    if (kind === 'info') return theme === 'dark' ? '#94a3b8' : '#64748b';
    return theme === 'dark' ? '#cbd5e1' : '#334155';
  };

  return (
    <div onClick={() => inputRef.current?.focus()}
      style={{
        position: 'absolute', inset: 0,
        background: theme === 'dark' ? '#0a0c10' : '#0f1115',
        color: '#cbd5e1', fontFamily: HV2_MONO_DOCK, fontSize: 12, lineHeight: 1.55,
        padding: '12px 14px',
        display: 'flex', flexDirection: 'column',
        cursor: 'text',
      }}>
      <div ref={scrollRef} style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
        {history.map((line, i) => (
          <div key={i} style={{ color: colorFor(line.kind), whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
            {line.text}
          </div>
        ))}
        {/* current prompt */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 0, color: '#cbd5e1' }}>
          <span style={{ color: '#10b981' }}>{promptStr}</span>
          <input ref={inputRef} autoFocus
            value={input}
            onChange={e => updateTabState({ input: e.target.value })}
            onKeyDown={onKey}
            spellCheck={false}
            style={{
              flex: 1, background: 'transparent', border: 'none', outline: 'none',
              color: 'inherit', fontFamily: 'inherit', fontSize: 'inherit', padding: 0,
              caretColor: '#10b981',
            }} />
        </div>
      </div>
    </div>
  );
}

// Canned kubectl response generator. Returns an array of history entries.
function runCannedCommand(raw, cluster, activeNs) {
  const cmd = raw.toLowerCase();
  const tokens = raw.trim().split(/\s+/);

  if (cmd === 'help') {
    return [
      { kind: 'info', text: 'Demo terminal — supported (canned) commands:' },
      { kind: 'out',  text: '  kubectl get pods            kubectl get nodes' },
      { kind: 'out',  text: '  kubectl get configmaps      kubectl get ns' },
      { kind: 'out',  text: '  kubectl describe pod <name> kubectl logs <name>' },
      { kind: 'out',  text: '  kubectl version             kubectl config current-context' },
      { kind: 'out',  text: '  clear                       help' },
    ];
  }
  if (cmd === 'clear') return []; // handled elsewhere ideally; we just emit nothing here
  if (cmd === 'kubectl version' || cmd === 'kubectl version --short') {
    return [
      { kind: 'out', text: `Client Version: v1.30.0` },
      { kind: 'out', text: `Server Version: ${cluster.version}` },
    ];
  }
  if (cmd === 'kubectl config current-context') {
    return [{ kind: 'out', text: cluster.id }];
  }
  if (cmd === 'kubectl get ns' || cmd === 'kubectl get namespaces') {
    const lines = ['NAME              STATUS   AGE'];
    cluster.namespaces.forEach(ns => {
      lines.push(`${ns.padEnd(18)}Active   ${(Math.floor(Math.random()*40)+5)}d`);
    });
    return lines.map(text => ({ kind: 'out', text }));
  }
  if (/^kubectl\s+get\s+(pods?|po)/.test(cmd)) {
    const pods = (window.PODS_BY_CLUSTER[cluster.id] || []).filter(p =>
      !activeNs || activeNs.size === 0 || activeNs.has(p.ns)
    );
    if (pods.length === 0) return [{ kind: 'info', text: 'No resources found.' }];
    const lines = ['NAME                                       READY   STATUS         RESTARTS   AGE'];
    pods.slice(0, 18).forEach(p => {
      lines.push(
        p.name.padEnd(43) +
        p.ready.padEnd(8) +
        p.status.padEnd(15) +
        String(p.restarts).padEnd(11) +
        p.age
      );
    });
    if (pods.length > 18) lines.push(`… ${pods.length - 18} more`);
    return lines.map(text => ({ kind: 'out', text }));
  }
  if (/^kubectl\s+get\s+(nodes?|no)/.test(cmd)) {
    const nodes = window.NODES_BY_CLUSTER[cluster.id] || [];
    const lines = ['NAME              STATUS   ROLES           AGE     VERSION'];
    nodes.forEach(n => {
      lines.push(`${n.name.padEnd(18)}${n.status.padEnd(9)}${(n.roles || 'worker').padEnd(16)}${(n.age || '12d').padEnd(8)}${cluster.version}`);
    });
    return lines.map(text => ({ kind: 'out', text }));
  }
  if (/^kubectl\s+get\s+(configmaps?|cm)/.test(cmd)) {
    const cms = (window.CONFIGMAPS_BY_CLUSTER[cluster.id] || []).filter(c =>
      !activeNs || activeNs.size === 0 || activeNs.has(c.ns)
    );
    if (cms.length === 0) return [{ kind: 'info', text: 'No resources found.' }];
    const lines = ['NAME                          DATA   AGE'];
    cms.slice(0, 12).forEach(c => {
      lines.push(`${c.name.padEnd(30)}${String(c.keys).padEnd(7)}${c.age}`);
    });
    return lines.map(text => ({ kind: 'out', text }));
  }
  if (/^kubectl\s+describe\s+pod/.test(cmd)) {
    const target = tokens[3] || '';
    const pod = (window.PODS_BY_CLUSTER[cluster.id] || []).find(p => p.name === target || p.name.startsWith(target));
    if (!pod) return [{ kind: 'err', text: `Error from server (NotFound): pods "${target}" not found` }];
    return [
      { kind: 'out', text: `Name:         ${pod.name}` },
      { kind: 'out', text: `Namespace:    ${pod.ns}` },
      { kind: 'out', text: `Node:         ${pod.node}` },
      { kind: 'out', text: `Status:       ${pod.status}` },
      { kind: 'out', text: `IP:           10.${Math.floor(Math.random()*200)}.${Math.floor(Math.random()*200)}.${Math.floor(Math.random()*200)}` },
      { kind: 'out', text: `Containers:` },
      ...(pod.containers || []).map(c => ({ kind: 'out', text: `  ${c.name}:` })),
      ...(pod.containers || []).flatMap(c => [
        { kind: 'out', text: `    Image:    ${c.image}` },
        { kind: 'out', text: `    State:    ${c.status}` },
      ]),
      { kind: 'out', text: `Events:       <none>` },
    ];
  }
  if (/^kubectl\s+logs/.test(cmd)) {
    return [
      { kind: 'out', text: '2026-04-30T14:22:01Z INFO  server listening on :8080' },
      { kind: 'out', text: '2026-04-30T14:22:03Z INFO  connected to postgres' },
      { kind: 'out', text: '2026-04-30T14:24:18Z INFO  processed 142 requests in 30s' },
      { kind: 'out', text: '2026-04-30T14:24:32Z WARN  slow query (412ms)' },
    ];
  }
  if (/^kubectl\s+apply/.test(cmd)) {
    return [{ kind: 'info', text: 'Tip: paste the manifest into the YAML tab and click Apply for a richer preview.' }];
  }
  if (/^(ls|pwd|cd|whoami|echo)/.test(cmd)) {
    return [{ kind: 'err', text: `command not found: ${tokens[0]} (this is a kubectl-only sandbox)` }];
  }
  return [{ kind: 'err', text: `error: unknown command "${tokens[0] || ''}"  ·  type "help" for options` }];
}

// ── YAML tab ────────────────────────────────────────────────────────────────
const YAML_TEMPLATES = {
  deployment: {
    label: 'Deployment',
    body: `apiVersion: apps/v1
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
          resources:
            requests:
              cpu: 100m
              memory: 128Mi
            limits:
              cpu: 500m
              memory: 256Mi
`,
  },
  service: {
    label: 'Service',
    body: `apiVersion: v1
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
`,
  },
  configmap: {
    label: 'ConfigMap',
    body: `apiVersion: v1
kind: ConfigMap
metadata:
  name: app-config
  namespace: default
data:
  LOG_LEVEL: info
  FEATURE_FLAGS: |
    payments=true
    referrals=false
`,
  },
  ingress: {
    label: 'Ingress',
    body: `apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: hello-world
  namespace: default
  annotations:
    nginx.ingress.kubernetes.io/rewrite-target: /
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
`,
  },
};

function DockYaml({ t, theme, cluster, activeNs, tab, updateTabState, updateTab }) {
  const { content, template, lastAction } = tab.state;
  const taRef = React.useRef(null);

  const setContent = (v) => updateTabState({ content: v });
  const setTemplate = (key) => {
    if (key && YAML_TEMPLATES[key]) {
      updateTabState({ content: YAML_TEMPLATES[key].body, template: key, lastAction: null });
    }
  };

  // Detect resource title from the content for the tab title.
  React.useEffect(() => {
    const m = content.match(/^kind:\s*(\w+)/m);
    const n = content.match(/^\s*name:\s*([\w-]+)/m);
    if (m && n) {
      const title = `${n[1]}.${m[1].toLowerCase()}.yaml`;
      if (tab.title !== title) updateTab({ title });
    }
  }, [content]);

  const ns = activeNs && activeNs.size === 1 ? [...activeNs][0] : 'default';

  const lint = () => {
    const errs = [];
    if (!/^apiVersion:/m.test(content)) errs.push('missing apiVersion');
    if (!/^kind:/m.test(content)) errs.push('missing kind');
    if (!/^\s*name:/m.test(content)) errs.push('missing metadata.name');
    if (/\t/.test(content)) errs.push('tabs are not allowed in YAML — use spaces');
    return errs;
  };

  const doAction = (kind) => {
    const errs = lint();
    if (errs.length) {
      updateTabState({ lastAction: { kind, status: 'error', errors: errs, ts: Date.now() } });
      return;
    }
    const m = content.match(/^kind:\s*(\w+)/m);
    const n = content.match(/^\s*name:\s*([\w-]+)/m);
    const resource = m ? m[1].toLowerCase() : 'resource';
    const name = n ? n[1] : 'unknown';
    let result;
    if (kind === 'apply') {
      result = { kind, status: 'ok', message: `${resource}.${m ? 'apps' : 'core'}/${name} created (server-side)`, ts: Date.now() };
    } else if (kind === 'dryrun') {
      result = { kind, status: 'ok', message: `${resource}/${name} (dry run) — would be created`, ts: Date.now(), diff: [
        `+ ${resource} "${name}" (new)`,
        `+ namespace: ${ns}`,
        `+ labels: app=${name}`,
      ] };
    } else if (kind === 'validate') {
      result = { kind, status: 'ok', message: `${resource}/${name} is valid against schema ${m && m[1] === 'Deployment' ? 'apps/v1' : 'v1'}`, ts: Date.now() };
    }
    updateTabState({ lastAction: result });
  };

  const lineCount = content.split('\n').length;

  return (
    <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column' }}>
      {/* toolbar */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '7px 12px', borderBottom: `1px solid ${t.borderSoft}`,
        background: t.surfaceAlt, flexShrink: 0,
      }}>
        <span style={{ fontSize: 11, color: t.textMuted }}>Template</span>
        <select value={template || ''} onChange={e => setTemplate(e.target.value)}
          style={{
            border: `1px solid ${t.border}`, background: t.surface, color: t.text,
            padding: '3px 8px', borderRadius: 5, fontSize: 11.5, fontFamily: 'inherit',
            cursor: 'pointer', outline: 'none',
          }}>
          {Object.entries(YAML_TEMPLATES).map(([k, v]) => (
            <option key={k} value={k}>{v.label}</option>
          ))}
        </select>
        <div style={{ width: 1, height: 16, background: t.borderSoft }} />
        <button onClick={() => doAction('validate')} style={ybtn(t, 'secondary')} title="Schema validation">
          <svg width="11" height="11" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M2.5 7.5l3 3 6-7"/></svg>
          Validate
        </button>
        <button onClick={() => doAction('dryrun')} style={ybtn(t, 'secondary')} title="kubectl apply --dry-run=server">
          <svg width="11" height="11" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="7" cy="7" r="5"/><path d="M5 7l1.5 1.5L9 6"/></svg>
          Dry-run
        </button>
        <button onClick={() => doAction('apply')} style={ybtn(t, 'primary')} title="kubectl apply -f">
          <svg width="11" height="11" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M7 1v9 M3 6l4 4 4-4 M2 13h10"/></svg>
          Apply
        </button>
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 10.5, color: t.textMuted, fontFamily: HV2_MONO_DOCK }}>
          {lineCount} lines · {content.length} chars
        </span>
      </div>

      {/* editor + result split */}
      <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
        <div style={{ flex: 1, minWidth: 0, position: 'relative' }}>
          <textarea ref={taRef} value={content} onChange={e => setContent(e.target.value)}
            spellCheck={false}
            style={{
              position: 'absolute', inset: 0,
              width: '100%', height: '100%', resize: 'none',
              background: theme === 'dark' ? '#0e1116' : '#fbfcfd',
              color: theme === 'dark' ? '#e2e8f0' : '#1e293b',
              border: 'none', outline: 'none',
              padding: '12px 14px',
              fontFamily: HV2_MONO_DOCK, fontSize: 12, lineHeight: 1.55,
              tabSize: 2,
            }} />
        </div>
        {lastAction && (
          <div style={{
            width: 280, flexShrink: 0,
            borderLeft: `1px solid ${t.borderSoft}`,
            background: t.surfaceAlt, padding: '12px 14px',
            overflow: 'auto', fontSize: 11.5, color: t.text,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
              <span style={{
                width: 7, height: 7, borderRadius: '50%',
                background: lastAction.status === 'ok' ? '#10b981' : '#f43f5e',
              }} />
              <span style={{ fontWeight: 600, textTransform: 'uppercase', fontSize: 10, letterSpacing: 0.5, color: t.textDim }}>
                {lastAction.kind === 'apply' ? 'Apply' : lastAction.kind === 'dryrun' ? 'Dry-run' : 'Validate'}
              </span>
              <span style={{ marginLeft: 'auto', fontSize: 10, color: t.textMuted, fontFamily: HV2_MONO_DOCK }}>
                {new Date(lastAction.ts).toLocaleTimeString()}
              </span>
            </div>
            {lastAction.status === 'ok' ? (
              <>
                <div style={{ fontFamily: HV2_MONO_DOCK, fontSize: 11.5, color: '#10b981', marginBottom: 10 }}>
                  ✓ {lastAction.message}
                </div>
                {lastAction.diff && (
                  <pre style={{
                    margin: 0, padding: '8px 10px', borderRadius: 5,
                    background: theme === 'dark' ? '#0e1116' : '#fff',
                    border: `1px solid ${t.borderSoft}`,
                    fontFamily: HV2_MONO_DOCK, fontSize: 11, lineHeight: 1.5,
                    color: '#10b981', whiteSpace: 'pre-wrap',
                  }}>{lastAction.diff.join('\n')}</pre>
                )}
              </>
            ) : (
              <>
                <div style={{ fontFamily: HV2_MONO_DOCK, fontSize: 11.5, color: '#f43f5e', marginBottom: 8 }}>
                  ✗ {lastAction.errors.length} error{lastAction.errors.length === 1 ? '' : 's'}
                </div>
                <ul style={{ margin: 0, padding: '0 0 0 16px', color: t.textDim, lineHeight: 1.6 }}>
                  {lastAction.errors.map((e, i) => <li key={i}>{e}</li>)}
                </ul>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function ybtn(t, variant) {
  const isPrimary = variant === 'primary';
  return {
    border: isPrimary ? 'none' : `1px solid ${t.border}`,
    background: isPrimary ? t.accent : t.surface,
    color: isPrimary ? '#fff' : t.text,
    padding: '4px 9px', borderRadius: 5, fontSize: 11.5, fontWeight: 600,
    cursor: 'pointer', fontFamily: 'inherit',
    display: 'inline-flex', alignItems: 'center', gap: 5,
  };
}

Object.assign(window, { HV2Dock, makeTerminalTab, makeYamlTab });
