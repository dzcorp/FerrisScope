// Helmsman v2 — main app shell

function HV2App({ theme = 'light', showNamespace = true, railPinned = false }) {
  const [activeCluster, setActiveCluster] = React.useState(null);
  const [activeTab, setActiveTab] = React.useState('pods');
  const [activeNs, setActiveNs] = React.useState(new Set()); // empty = all
  const [nsModalOpen, setNsModalOpen] = React.useState(false);
  const [dockTabs, setDockTabs] = React.useState([]);
  const [dockActiveId, setDockActiveId] = React.useState(null);
  const [dockMin, setDockMin] = React.useState(false);
  const [addMenuOpen, setAddMenuOpen] = React.useState(false);
  const [selectedPod, setSelectedPod] = React.useState(null);
  const [selected, setSelected] = React.useState(new Set()); // multi-select pod names
  const [railHover, setRailHover] = React.useState(false);
  const [pinned, setPinned] = React.useState(railPinned);
  const [paletteOpen, setPaletteOpen] = React.useState(false);
  const [paletteQ, setPaletteQ] = React.useState('');
  const [settingsOpen, setSettingsOpen] = React.useState(false);

  // Settings (independent of Tweaks for demo purposes)
  const [settings, setSettingsState] = React.useState({
    defaultNs: 'default',
    refreshSec: 15,
    confirmDestructive: true,
    showSystemNs: false,
    theme,
    accent: 'teal',
    density: 'comfortable',
    monoTables: true,
    kubeconfigPath: '~/.kube/config',
    autoDetectCloud: true,
    refreshOnLaunch: true,
  });
  const setSettings = (patch) => setSettingsState(s => ({ ...s, ...patch }));

  React.useEffect(() => { setPinned(railPinned); }, [railPinned]);
  React.useEffect(() => { setSettings({ theme }); }, [theme]);

  const dark = theme === 'dark';
  const t = dark ? {
    bg: '#0d1014', surface: '#161a20', surfaceAlt: '#11141a',
    header: '#11141a', headerAlt: '#191d24',
    border: '#23282f', borderSoft: '#1c2027',
    text: '#e8eaef', textDim: '#a0a6b0', textMuted: '#6c7280',
    accent: '#2dd4bf', accentSoft: 'rgba(45,212,191,0.14)',
    accentHover: '#26b9a7', accentActive: '#1f9b8b',
    chip: '#1d2128', hover: 'rgba(255,255,255,0.04)',
    btnHover: '#1c2128',
    rail: '#11141a', railHover: 'rgba(255,255,255,0.05)',
    scrim: 'rgba(8,10,14,0.55)',
    paletteBg: 'rgba(20,22,28,0.92)', paletteBorder: '#2a2d36',
    bulkBg: '#161a20',
  } : {
    bg: '#f7f8fa', surface: '#ffffff', surfaceAlt: '#f7f8fa',
    header: '#ffffff', headerAlt: '#fafbfc',
    border: '#e3e6ec', borderSoft: '#eef0f4',
    text: '#11161d', textDim: '#525a68', textMuted: '#8a93a0',
    accent: '#0d9488', accentSoft: '#d8f4f0',
    accentHover: '#0b827a', accentActive: '#0a6e68',
    chip: '#eef0f4', hover: 'rgba(15,20,30,0.035)',
    btnHover: '#f4f6f9',
    rail: '#ffffff', railHover: 'rgba(15,20,30,0.04)',
    scrim: 'rgba(15,20,30,0.22)',
    paletteBg: 'rgba(255,255,255,0.97)', paletteBorder: '#d6dae2',
    bulkBg: '#11161d',
  };

  const cluster = activeCluster ? CLUSTERS.find(c => c.id === activeCluster) : null;
  const railOpen = pinned || railHover;
  const RAIL_W = 56;

  // global keyboard
  React.useEffect(() => {
    const handler = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen(o => !o);
      }
      if (e.key === 'Escape') {
        if (addMenuOpen) setAddMenuOpen(false);
        else if (paletteOpen) setPaletteOpen(false);
        else if (nsModalOpen) setNsModalOpen(false);
        else if (settingsOpen) setSettingsOpen(false);
        else if (selectedPod) setSelectedPod(null);
        else if (selected.size) setSelected(new Set());
      }
      // Quick keys for opening dock tabs (when a cluster is open)
      if (cluster && (e.metaKey || e.ctrlKey)) {
        if (e.key === '`') {
          e.preventDefault();
          openDockTab('terminal');
        } else if (e.key.toLowerCase() === 'y' && e.shiftKey) {
          e.preventDefault();
          openDockTab('yaml');
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [paletteOpen, nsModalOpen, settingsOpen, selectedPod, selected, addMenuOpen, cluster, dockTabs]);

  // Reset dock when cluster cleared
  React.useEffect(() => {
    if (!cluster) { setDockTabs([]); setDockActiveId(null); setDockMin(false); }
  }, [cluster]);

  const openDockTab = (kind) => {
    if (!cluster) return;
    const tab = kind === 'terminal' ? makeTerminalTab(cluster, activeNs) : makeYamlTab(cluster, activeNs);
    setDockTabs(prev => [...prev, tab]);
    setDockActiveId(tab.id);
    setDockMin(false);
    setAddMenuOpen(false);
  };
  const closeDock = () => { setDockTabs([]); setDockActiveId(null); setDockMin(false); };

  // clear selection when context changes
  React.useEffect(() => { setSelected(new Set()); }, [activeCluster, activeTab, activeNs]);

  return (
    <DesktopWindow theme={theme}
      titleBar={<div style={{ fontSize: 13, fontWeight: 500, color: t.textDim, letterSpacing: -0.1 }}>Helmsman</div>}>
      <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', background: t.bg, color: t.text, fontFamily: HV2_FONT, position: 'relative' }}>

        <HV2Header t={t} cluster={cluster} activeTab={activeTab}
          onHome={() => { setActiveCluster(null); setSelectedPod(null); }}
          onPalette={() => setPaletteOpen(true)}
          onSettings={() => setSettingsOpen(true)} />

        {cluster && <HV2ClusterBar cluster={cluster} t={t} theme={theme} activeNs={activeNs}
          onOpenNs={() => setNsModalOpen(true)} showNamespace={showNamespace}
          addMenuOpen={addMenuOpen} setAddMenuOpen={setAddMenuOpen}
          onAddTerminal={() => openDockTab('terminal')}
          onAddYaml={() => openDockTab('yaml')}
          dockTabCount={dockTabs.length} />}

        {/* MAIN */}
        <div style={{ flex: 1, minHeight: 0, display: 'flex', overflow: 'hidden', position: 'relative' }}>
          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden', paddingLeft: cluster ? RAIL_W : 0 }}>
            {!cluster ? (
              <HV2Landing t={t} theme={theme} onSelect={(id) => { setActiveCluster(id); setActiveTab('pods'); setSelectedPod(null); }} />
            ) : (
              <HV2Cluster cluster={cluster} t={t} theme={theme} activeTab={activeTab} activeNs={activeNs}
                selectedPod={selectedPod} setSelectedPod={setSelectedPod}
                selected={selected} setSelected={setSelected} />
            )}
          </div>

          {cluster && (
            <HV2Rail t={t} activeTab={activeTab} setActiveTab={setActiveTab}
              cluster={cluster} open={railOpen} pinned={pinned} setPinned={setPinned}
              setHover={setRailHover} onSettings={() => setSettingsOpen(true)} />
          )}

          {selectedPod && cluster && activeTab === 'pods' && (
            <HV2PodDetailOverlay pod={selectedPod} cluster={cluster} t={t} theme={theme}
              onClose={() => setSelectedPod(null)} />
          )}

          {/* Bulk action bar — slides up from bottom when pods are selected */}
          {selected.size > 0 && cluster && activeTab === 'pods' && !settingsOpen && (
            <HV2BulkBar t={t} count={selected.size}
              onClear={() => setSelected(new Set())} />
          )}

          {/* Bottom dock — terminals + YAML scratchpads */}
          {cluster && dockTabs.length > 0 && (
            <HV2Dock t={t} theme={theme} cluster={cluster} activeNs={activeNs}
              tabs={dockTabs} setTabs={setDockTabs}
              activeTabId={dockActiveId} setActiveTabId={setDockActiveId}
              minimized={dockMin} setMinimized={setDockMin}
              onClose={closeDock} />
          )}
        </div>

        {paletteOpen && (
          <HV2Palette t={t} q={paletteQ} setQ={setPaletteQ}
            cluster={cluster} activeCluster={activeCluster}
            onPick={(action) => { action(); setPaletteOpen(false); setPaletteQ(''); }}
            onClose={() => { setPaletteOpen(false); setPaletteQ(''); }}
            setActiveCluster={setActiveCluster} setActiveTab={setActiveTab}
            setSelectedPod={setSelectedPod} setActiveNs={setActiveNs} />
        )}

        {nsModalOpen && cluster && (
          <HV2NamespaceModal t={t} theme={theme} cluster={cluster}
            activeNs={activeNs} setActiveNs={setActiveNs}
            onClose={() => setNsModalOpen(false)} />
        )}

        {settingsOpen && (
          <HV2Settings t={t} theme={theme} settings={settings} setSettings={setSettings}
            onClose={() => setSettingsOpen(false)} />
        )}
      </div>
    </DesktopWindow>
  );
}

// ── Header ─────────────────────────────────────────────────────────────────
function HV2Header({ t, cluster, activeTab, onHome, onPalette, onSettings }) {
  return (
    <div style={{ background: t.header, borderBottom: `1px solid ${t.border}`, flexShrink: 0, zIndex: 5 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '12px 22px' }}>
        <button onClick={onHome}
          style={{ display: 'flex', alignItems: 'center', gap: 9, border: 'none', background: 'transparent', cursor: 'pointer', color: t.text, fontFamily: 'inherit', padding: 0 }}>
          <div style={{
            width: 26, height: 26, borderRadius: 7,
            background: t.accent, color: 'white',
            display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: 12, letterSpacing: -0.5,
          }}>H</div>
          <div style={{ fontSize: 14, fontWeight: 700, letterSpacing: -0.3 }}>Helmsman</div>
        </button>

        <div style={{ height: 18, width: 1, background: t.border }} />

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 500, minWidth: 0 }}>
          <button onClick={onHome}
            style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: cluster ? t.textDim : t.text, padding: '3px 6px', borderRadius: 4, fontFamily: 'inherit', fontSize: 13, fontWeight: 500 }}>
            Clusters
          </button>
          {cluster && (
            <>
              <span style={{ color: t.textMuted, display: 'inline-flex' }}>{Icons.chevR}</span>
              <span style={{ padding: '3px 6px', fontWeight: 600, letterSpacing: -0.2 }}>{cluster.name}</span>
              <span style={{ fontSize: 11, padding: '1px 6px', borderRadius: 3, background: t.chip, color: t.textDim, fontWeight: 500, marginLeft: 2 }}>{cluster.env}</span>
              {activeTab && (
                <>
                  <span style={{ color: t.textMuted, display: 'inline-flex' }}>{Icons.chevR}</span>
                  <span style={{ padding: '3px 6px', color: t.textDim, textTransform: 'capitalize' }}>{activeTab}</span>
                </>
              )}
            </>
          )}
        </div>

        <div style={{ flex: 1 }} />

        <button onClick={onPalette}
          style={{
            display: 'flex', alignItems: 'center', gap: 6,
            border: `1px solid ${t.border}`, background: t.surface,
            borderRadius: 7, padding: '6px 12px', width: 280, cursor: 'pointer',
            fontFamily: 'inherit', color: 'inherit', height: 32,
          }}>
          <span style={{ color: t.textMuted, display: 'inline-flex' }}>{Icons.search}</span>
          <span style={{ flex: 1, color: t.textMuted, fontSize: 12, textAlign: 'left' }}>Search clusters, pods, nodes…</span>
          <span style={{ fontSize: 10.5, color: t.textMuted, fontFamily: HV2_MONO, padding: '1px 5px', borderRadius: 3, background: t.chip }}>⌘K</span>
        </button>

        <IconBtn t={t} title="Settings" onClick={onSettings}>{Icons.settings}</IconBtn>
      </div>
    </div>
  );
}

// ── Cluster context bar ────────────────────────────────────────────────────
function HV2ClusterBar({ cluster, t, theme, activeNs, onOpenNs, showNamespace,
                        addMenuOpen, setAddMenuOpen, onAddTerminal, onAddYaml, dockTabCount }) {
  const cpuColor = cluster.cpu > 0.8 ? '#f43f5e' : cluster.cpu > 0.65 ? '#f59e0b' : '#10b981';
  const memColor = cluster.mem > 0.8 ? '#f43f5e' : cluster.mem > 0.65 ? '#f59e0b' : '#10b981';

  const nsCount = activeNs ? activeNs.size : 0;
  const nsAll = nsCount === 0;
  const nsSummary = nsAll
    ? 'All namespaces'
    : nsCount === 1
      ? [...activeNs][0]
      : `${nsCount} namespaces`;
  const nsSecondary = nsAll
    ? `${cluster.namespaces.length} available`
    : nsCount > 1 ? [...activeNs].slice(0, 2).join(', ') + (nsCount > 2 ? '…' : '') : null;

  return (
    <div style={{ background: t.headerAlt, borderBottom: `1px solid ${t.border}`, padding: '12px 22px', display: 'flex', alignItems: 'center', gap: 22 }}>
      <HV2Stat label="Status" value={<StatusPill status={cluster.status} theme={theme} />} t={t} />
      <HV2Stat label="Nodes" value={cluster.nodes} t={t} />
      <HV2Stat label="Pods" value={cluster.pods.toLocaleString()} t={t} />
      <HV2Stat label="Region" value={cluster.region} t={t} mono />
      <HV2Stat label="Version" value={cluster.version} t={t} mono />

      <div style={{ flex: 1 }} />

      <div style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Gauge value={cluster.cpu} size={36} thickness={3.5} color={cpuColor} track={t.borderSoft} showValue={false} />
          <div>
            <div style={{ fontSize: 10, color: t.textMuted, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.4 }}>CPU</div>
            <div style={{ fontSize: 12, fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>{Math.round(cluster.cpu * 100)}%</div>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Gauge value={cluster.mem} size={36} thickness={3.5} color={memColor} track={t.borderSoft} showValue={false} />
          <div>
            <div style={{ fontSize: 10, color: t.textMuted, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.4 }}>MEM</div>
            <div style={{ fontSize: 12, fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>{Math.round(cluster.mem * 100)}%</div>
          </div>
        </div>

        {/* "+" menu — opens terminal or YAML in dock */}
        <div style={{ position: 'relative', marginLeft: 6 }}>
          <button onClick={() => setAddMenuOpen(o => !o)}
            title="New terminal or YAML scratchpad"
            style={{
              border: `1px solid ${t.border}`,
              background: addMenuOpen ? t.btnHover : t.surface,
              color: t.text,
              width: 36, height: 36, borderRadius: 7,
              cursor: 'pointer', outline: 'none',
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              position: 'relative',
              transition: 'background .12s, border-color .12s',
            }}
            onMouseEnter={e => { e.currentTarget.style.background = t.btnHover; }}
            onMouseLeave={e => { e.currentTarget.style.background = addMenuOpen ? t.btnHover : t.surface; }}>
            <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke={t.textDim} strokeWidth="1.6" strokeLinecap="round">
              <path d="M7 2v10 M2 7h10"/>
            </svg>
            {dockTabCount > 0 && (
              <span style={{
                position: 'absolute', top: -3, right: -3,
                minWidth: 14, height: 14, padding: '0 3px',
                borderRadius: 7, background: t.accent, color: '#fff',
                fontSize: 9, fontWeight: 700, fontFamily: HV2_MONO,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                border: `2px solid ${t.headerAlt}`,
              }}>{dockTabCount}</span>
            )}
          </button>
          {addMenuOpen && (
            <>
              <div onClick={() => setAddMenuOpen(false)}
                style={{ position: 'fixed', inset: 0, zIndex: 30 }} />
              <div style={{
                position: 'absolute', right: 0, top: 'calc(100% + 6px)',
                background: t.surface, border: `1px solid ${t.border}`,
                borderRadius: 8, padding: 4, minWidth: 220, zIndex: 31,
                boxShadow: theme === 'dark' ? '0 8px 24px rgba(0,0,0,0.4)' : '0 8px 24px rgba(15,20,30,0.12)',
              }}>
                <AddMenuItem t={t} onClick={onAddTerminal}
                  icon={<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M3 3l3 3-3 3 M7 9h4"/></svg>}
                  title="New terminal" kbd="⌘ `" subtitle="Run kubectl in this cluster" />
                <AddMenuItem t={t} onClick={onAddYaml}
                  icon={<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M2 7l2-2-2-2M12 3l-2 2 2 2M6 11l3-8"/></svg>}
                  title="New YAML scratchpad" kbd="⇧⌘Y" subtitle="Write or paste a manifest, then apply" />
              </div>
            </>
          )}
        </div>

        {showNamespace && (
          <button onClick={onOpenNs}
            title="Filter by namespace"
            style={{
              border: `1px solid ${nsAll ? t.border : t.accent}`,
              background: nsAll ? t.surface : t.accentSoft,
              color: t.text,
              padding: '5px 10px 5px 9px', borderRadius: 7, fontSize: 12,
              fontFamily: 'inherit', cursor: 'pointer', outline: 'none',
              marginLeft: 6, height: 36,
              display: 'inline-flex', alignItems: 'center', gap: 8,
              transition: 'background .12s, border-color .12s',
            }}
            onMouseEnter={e => { if (nsAll) e.currentTarget.style.background = t.btnHover; }}
            onMouseLeave={e => { if (nsAll) e.currentTarget.style.background = t.surface; }}>
            {/* layers icon */}
            <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke={nsAll ? t.textDim : t.accent} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
              <path d="M7 1.5 1.5 4 7 6.5 12.5 4 7 1.5z"/>
              <path d="M1.5 7 7 9.5 12.5 7"/>
              <path d="M1.5 10 7 12.5 12.5 10"/>
            </svg>
            <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', lineHeight: 1.15 }}>
              <span style={{ fontSize: 9.5, color: t.textMuted, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.4 }}>Namespace</span>
              <span style={{
                fontSize: 12, fontWeight: 600,
                fontFamily: nsAll || nsCount > 1 ? 'inherit' : HV2_MONO,
                color: nsAll ? t.text : t.accent,
              }}>{nsSummary}</span>
            </span>
            {!nsAll && nsCount > 1 && (
              <span style={{ fontSize: 10, color: t.accent, opacity: 0.75, marginLeft: 2, fontFamily: HV2_MONO, maxWidth: 110, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{nsSecondary}</span>
            )}
            <svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke={t.textMuted} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ marginLeft: 2 }}>
              <path d="M2 4l3 3 3-3"/>
            </svg>
          </button>
        )}
      </div>
    </div>
  );
}

function AddMenuItem({ t, icon, title, subtitle, kbd, onClick }) {
  const [hover, setHover] = React.useState(false);
  return (
    <button onClick={onClick}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex', alignItems: 'center', gap: 10, width: '100%',
        padding: '8px 10px', borderRadius: 5,
        border: 'none', background: hover ? t.hover : 'transparent',
        cursor: 'pointer', textAlign: 'left', color: t.text,
        fontFamily: 'inherit',
      }}>
      <span style={{
        width: 26, height: 26, borderRadius: 5, flexShrink: 0,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: t.chip, color: t.textDim,
      }}>{icon}</span>
      <span style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0 }}>
        <span style={{ fontSize: 12.5, fontWeight: 600, color: t.text }}>{title}</span>
        <span style={{ fontSize: 10.5, color: t.textMuted, marginTop: 1 }}>{subtitle}</span>
      </span>
      {kbd && (
        <span style={{
          fontSize: 10, color: t.textMuted, fontFamily: HV2_MONO,
          padding: '2px 5px', border: `1px solid ${t.borderSoft}`, borderRadius: 4,
          background: t.surfaceAlt,
        }}>{kbd}</span>
      )}
    </button>
  );
}

function HV2Stat({ label, value, t, mono }) {
  return (
    <div>
      <div style={{ fontSize: 10, color: t.textMuted, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 2 }}>{label}</div>
      <div style={{ fontSize: 13, fontWeight: 600, fontFamily: mono ? HV2_MONO : 'inherit', fontVariantNumeric: 'tabular-nums' }}>{value}</div>
    </div>
  );
}

// ── Landing ────────────────────────────────────────────────────────────────
function HV2Landing({ t, theme, onSelect }) {
  const grouped = { production: [], staging: [], development: [] };
  CLUSTERS.forEach(c => grouped[c.env].push(c));

  return (
    <div style={{ flex: 1, overflow: 'auto', padding: '32px 40px 48px' }}>
      <div style={{ marginBottom: 28 }}>
        <div style={{ fontSize: 24, fontWeight: 700, letterSpacing: -0.6, marginBottom: 4 }}>Cluster fleet</div>
        <div style={{ fontSize: 13.5, color: t.textDim }}>Click a cluster to switch context. {CLUSTERS.length} contexts loaded from kubeconfig.</div>
      </div>

      {Object.entries(grouped).map(([env, list]) => list.length > 0 && (
        <div key={env} style={{ marginBottom: 28 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: t.textDim, textTransform: 'uppercase', letterSpacing: 0.6 }}>{env}</div>
            <div style={{ flex: 1, height: 1, background: t.border }} />
            <div style={{ fontSize: 11.5, color: t.textMuted, fontVariantNumeric: 'tabular-nums' }}>{list.length}</div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 12 }}>
            {list.map(c => {
              const cpuColor = c.cpu > 0.8 ? '#f43f5e' : c.cpu > 0.65 ? '#f59e0b' : '#10b981';
              const memColor = c.mem > 0.8 ? '#f43f5e' : c.mem > 0.65 ? '#f59e0b' : '#10b981';
              return (
                <button key={c.id} onClick={() => onSelect(c.id)}
                  style={{
                    border: `1px solid ${t.border}`, borderRadius: 10,
                    background: t.surface, padding: 14, textAlign: 'left',
                    cursor: 'pointer', fontFamily: 'inherit', color: 'inherit',
                    transition: 'all .15s', display: 'flex', alignItems: 'center', gap: 14,
                  }}
                  onMouseEnter={e => { e.currentTarget.style.borderColor = t.accent; e.currentTarget.style.background = t.accentSoft; }}
                  onMouseLeave={e => { e.currentTarget.style.borderColor = t.border; e.currentTarget.style.background = t.surface; }}>
                  <div style={{ display: 'flex', gap: 4 }}>
                    <Gauge value={c.cpu} size={42} thickness={4} color={cpuColor} track={t.borderSoft} label="cpu" />
                    <Gauge value={c.mem} size={42} thickness={4} color={memColor} track={t.borderSoft} label="mem" />
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3 }}>
                      <div style={{ fontSize: 14, fontWeight: 600, letterSpacing: -0.3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name}</div>
                      <StatusPill status={c.status} theme={theme} dense />
                    </div>
                    <div style={{ fontSize: 11.5, color: t.textMuted, fontVariantNumeric: 'tabular-nums' }}>
                      {c.region} · {c.nodes} nodes · {c.pods} pods
                    </div>
                    <div style={{ fontSize: 10.5, color: t.textMuted, fontFamily: HV2_MONO, marginTop: 3 }}>{c.provider} · v{c.version}</div>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Cluster content ────────────────────────────────────────────────────────
function HV2Cluster({ cluster, t, theme, activeTab, activeNs, selectedPod, setSelectedPod, selected, setSelected }) {
  const nsAll = !activeNs || activeNs.size === 0;
  const pods = (PODS_BY_CLUSTER[cluster.id] || []).filter(p => nsAll || activeNs.has(p.ns));
  const nodes = (NODES_BY_CLUSTER[cluster.id] || []);
  const cms = (CONFIGMAPS_BY_CLUSTER[cluster.id] || []).filter(c => nsAll || activeNs.has(c.ns));
  const [ctxMenu, setCtxMenu] = React.useState(null);

  React.useEffect(() => {
    if (!ctxMenu) return;
    const close = () => setCtxMenu(null);
    window.addEventListener('click', close);
    window.addEventListener('scroll', close, true);
    return () => { window.removeEventListener('click', close); window.removeEventListener('scroll', close, true); };
  }, [ctxMenu]);

  const empty = (label) => (
    <div style={{ padding: '64px 40px', textAlign: 'center', color: t.textDim }}>
      <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>No {label} yet</div>
      <div style={{ fontSize: 12.5, color: t.textMuted }}>This cluster has nothing to show in this view.</div>
    </div>
  );

  return (
    <div style={{ flex: 1, overflow: 'auto', minWidth: 0 }}>
      {activeTab === 'pods' && <HV2PodTable pods={pods} t={t} theme={theme}
        selectedPod={selectedPod} setSelectedPod={setSelectedPod}
        selected={selected} setSelected={setSelected}
        setCtxMenu={setCtxMenu} />}
      {activeTab === 'nodes' && <HV2NodeTable nodes={nodes} t={t} theme={theme} />}
      {activeTab === 'configmaps' && <HV2CMTable cms={cms} t={t} />}
      {activeTab === 'deployments' && empty('Deployments')}
      {activeTab === 'secrets' && empty('Secrets')}
      {ctxMenu && <HV2PodMenu t={t} pod={ctxMenu.pod} x={ctxMenu.x} y={ctxMenu.y} onPick={(act) => { setCtxMenu(null); if (act === 'view') setSelectedPod(ctxMenu.pod); }} />}
    </div>
  );
}

// ── Pod table with multi-select ────────────────────────────────────────────
function HV2PodTable({ pods, t, theme, selectedPod, setSelectedPod, selected, setSelected, setCtxMenu }) {
  const openMenu = (e, p) => {
    e.preventDefault(); e.stopPropagation();
    setCtxMenu({ pod: p, x: e.clientX, y: e.clientY });
  };

  const allChecked = pods.length > 0 && pods.every(p => selected.has(p.name));
  const someChecked = pods.some(p => selected.has(p.name));
  const toggleAll = () => {
    if (allChecked) setSelected(new Set());
    else setSelected(new Set(pods.map(p => p.name)));
  };
  const toggleOne = (name) => {
    const next = new Set(selected);
    if (next.has(name)) next.delete(name); else next.add(name);
    setSelected(next);
  };

  if (pods.length === 0) {
    return (
      <div style={{ padding: '64px 40px', textAlign: 'center', color: t.textDim }}>
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>No pods match the current filters</div>
        <div style={{ fontSize: 12.5, color: t.textMuted }}>Try clearing the namespace filter, or switch clusters.</div>
      </div>
    );
  }

  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
      <thead style={{ position: 'sticky', top: 0, background: t.bg, zIndex: 1 }}>
        <tr style={{ borderBottom: `1px solid ${t.border}` }}>
          <th style={{ padding: '12px 8px 12px 18px', width: 32 }}>
            <Checkbox t={t} checked={allChecked} indeterminate={!allChecked && someChecked} onChange={toggleAll} />
          </th>
          {['Name', 'Namespace', 'Status', 'Ready', 'Restarts', 'CPU', 'Mem', 'Node', 'Age', ''].map((h, i) => (
            <th key={i} style={{
              padding: '12px 18px 12px ' + (i === 0 ? 8 : 18) + 'px',
              textAlign: i >= 4 && i <= 6 ? 'right' : 'left',
              fontSize: 11, fontWeight: 600, color: t.textMuted,
              letterSpacing: 0.3, textTransform: 'uppercase',
              width: i === 9 ? 36 : 'auto',
            }}>{h}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {pods.map(p => {
          const isSel = selectedPod && selectedPod.name === p.name;
          const isChecked = selected.has(p.name);
          const rowBg = isChecked ? t.accentSoft : isSel ? t.hover : 'transparent';
          return (
            <tr key={p.name} onClick={() => setSelectedPod(p)} onContextMenu={(e) => openMenu(e, p)}
              style={{ borderBottom: `1px solid ${t.borderSoft}`, cursor: 'pointer', background: rowBg }}
              onMouseEnter={e => { if (!isChecked && !isSel) e.currentTarget.style.background = t.hover; }}
              onMouseLeave={e => { if (!isChecked && !isSel) e.currentTarget.style.background = 'transparent'; }}>
              <td style={{ padding: '10px 8px 10px 18px' }}>
                <Checkbox t={t} checked={isChecked} onClick={() => toggleOne(p.name)} />
              </td>
              <td style={{ padding: '10px 18px 10px 8px', fontFamily: HV2_MONO, fontSize: 11.5, fontWeight: 500 }}>{p.name}</td>
              <td style={{ padding: '10px 18px', color: t.textDim }}>{p.ns}</td>
              <td style={{ padding: '10px 18px' }}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                  <StatusPill status={p.status} theme={theme} pod={p} compact />
                  <ContainerDots containers={p.containers} theme={theme} size={7} />
                </span>
              </td>
              <td style={{ padding: '10px 18px', color: t.textDim, fontVariantNumeric: 'tabular-nums' }}>{p.ready}</td>
              <td style={{ padding: '10px 18px', textAlign: 'right', fontVariantNumeric: 'tabular-nums',
                color: p.restarts > 5 ? '#f43f5e' : p.restarts > 0 ? '#f59e0b' : t.textDim, fontWeight: p.restarts > 0 ? 600 : 400 }}>{p.restarts}</td>
              <td style={{ padding: '10px 18px', textAlign: 'right', fontFamily: HV2_MONO, fontSize: 11.5, color: t.textDim }}>{p.cpu}m</td>
              <td style={{ padding: '10px 18px', textAlign: 'right', fontFamily: HV2_MONO, fontSize: 11.5, color: t.textDim }}>{fmtMi(p.mem)}</td>
              <td style={{ padding: '10px 18px', fontFamily: HV2_MONO, fontSize: 11, color: t.textMuted }}>{p.node}</td>
              <td style={{ padding: '10px 18px', color: t.textMuted, fontVariantNumeric: 'tabular-nums' }}>{p.age}</td>
              <td style={{ padding: '10px 8px', textAlign: 'right' }}>
                <button onClick={(e) => openMenu(e, p)} title="Actions"
                  style={{ width: 24, height: 24, border: 'none', borderRadius: 5, background: 'transparent', color: t.textMuted, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
                  onMouseEnter={e => { e.currentTarget.style.background = t.chip; e.currentTarget.style.color = t.text; }}
                  onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = t.textMuted; }}>
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor"><circle cx="3" cy="7" r="1.2"/><circle cx="7" cy="7" r="1.2"/><circle cx="11" cy="7" r="1.2"/></svg>
                </button>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

// ── Bulk action bar ────────────────────────────────────────────────────────
function HV2BulkBar({ t, count, onClear }) {
  return (
    <div style={{
      position: 'absolute', bottom: 22, left: '50%', transform: 'translateX(-50%)',
      background: t.bulkBg, color: '#fff',
      borderRadius: 10, padding: '8px 8px 8px 16px',
      display: 'flex', alignItems: 'center', gap: 10,
      boxShadow: '0 12px 36px rgba(0,0,0,0.25), 0 0 0 1px rgba(255,255,255,0.06)',
      zIndex: 9, animation: 'hv2-bulk .18s cubic-bezier(.2,.7,.2,1)',
    }}>
      <style>{`@keyframes hv2-bulk { from { opacity: 0; transform: translate(-50%, 12px) } to { opacity: 1; transform: translate(-50%, 0) } }`}</style>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, fontWeight: 500 }}>
        <span style={{
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          minWidth: 20, height: 20, padding: '0 6px',
          background: 'rgba(255,255,255,0.16)', borderRadius: 10,
          fontSize: 11, fontWeight: 700, fontVariantNumeric: 'tabular-nums',
        }}>{count}</span>
        <span>selected</span>
      </div>
      <div style={{ width: 1, height: 18, background: 'rgba(255,255,255,0.14)' }} />
      <BulkAction icon={Icons.logs} label="Logs" />
      <BulkAction icon={Icons.refresh} label="Restart" />
      <BulkAction icon={Icons.yaml} label="Edit YAML" />
      <BulkAction icon={Icons.copy} label="Copy names" />
      <div style={{ width: 1, height: 18, background: 'rgba(255,255,255,0.14)' }} />
      <BulkAction icon={Icons.trash} label="Delete" danger />
      <div style={{ width: 1, height: 18, background: 'rgba(255,255,255,0.14)' }} />
      <button onClick={onClear} title="Clear selection (Esc)"
        style={{
          width: 28, height: 28, borderRadius: 6, border: 'none',
          background: 'transparent', color: 'rgba(255,255,255,0.7)',
          cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        }}
        onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.10)'}
        onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
        {Icons.close}
      </button>
    </div>
  );
}

function BulkAction({ icon, label, danger }) {
  const [hover, setHover] = React.useState(false);
  return (
    <button onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6,
        padding: '5px 10px', height: 28, borderRadius: 6,
        border: 'none', background: hover ? (danger ? 'rgba(244,63,94,0.18)' : 'rgba(255,255,255,0.10)') : 'transparent',
        color: danger ? (hover ? '#fca5a5' : '#f87171') : '#fff',
        fontFamily: 'inherit', fontSize: 12, fontWeight: 500, cursor: 'pointer',
        transition: 'background .12s, color .12s',
      }}>
      <span style={{ display: 'inline-flex', opacity: 0.85 }}>{icon}</span>
      {label}
    </button>
  );
}

// ── Pod context menu ───────────────────────────────────────────────────────
function HV2PodMenu({ t, pod, x, y, onPick }) {
  const items = [
    { id: 'view',     label: 'View details',  icon: Icons.eye, kbd: '↵' },
    { id: 'logs',     label: 'View logs',     icon: Icons.logs, kbd: '⌘L' },
    { id: 'exec',     label: 'Exec shell',    icon: Icons.shell, kbd: '⌘E' },
    { id: 'yaml',     label: 'Edit YAML',     icon: Icons.yaml },
    { id: 'port',     label: 'Port forward',  icon: Icons.port },
    { id: 'sep' },
    { id: 'copy',     label: 'Copy name',     icon: Icons.copy },
    { id: 'sep' },
    { id: 'restart',  label: 'Restart pod',   icon: Icons.refresh },
    { id: 'delete',   label: 'Delete pod',    icon: Icons.trash, danger: true },
  ];
  const W = 210, H = items.filter(i => i.id !== 'sep').length * 30 + 16;
  const left = Math.min(x, window.innerWidth - W - 8);
  const top  = Math.min(y, window.innerHeight - H - 8);
  return (
    <div onClick={(e) => e.stopPropagation()} style={{
      position: 'fixed', left, top, width: W, zIndex: 30,
      background: t.surface, border: `1px solid ${t.border}`, borderRadius: 8,
      boxShadow: '0 12px 32px rgba(15,20,30,0.18)', padding: '6px 0',
      animation: 'hv2-menu .1s ease-out',
    }}>
      <style>{`@keyframes hv2-menu { from { opacity: 0; transform: scale(.97) } to { opacity: 1; transform: scale(1) } } @keyframes hv2-fade { from { opacity: 0 } to { opacity: 1 } } @keyframes hv2-slide { from { transform: translateX(100%) } to { transform: translateX(0) } }`}</style>
      <div style={{ padding: '4px 12px 6px', fontSize: 10.5, color: t.textMuted, fontFamily: HV2_MONO, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', borderBottom: `1px solid ${t.borderSoft}`, marginBottom: 4 }}>{pod.name}</div>
      {items.map((it, i) => it.id === 'sep' ? (
        <div key={i} style={{ height: 1, background: t.borderSoft, margin: '4px 0' }} />
      ) : (
        <button key={it.id} onClick={() => onPick(it.id)}
          style={{
            width: '100%', display: 'flex', alignItems: 'center', gap: 9,
            padding: '6px 12px', border: 'none', background: 'transparent',
            cursor: 'pointer', fontFamily: 'inherit', fontSize: 12.5,
            color: it.danger ? '#dc2626' : t.text, textAlign: 'left',
          }}
          onMouseEnter={e => e.currentTarget.style.background = it.danger ? 'rgba(220,38,38,0.08)' : t.hover}
          onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
          <span style={{ display: 'inline-flex', width: 13, opacity: 0.75, flexShrink: 0 }}>{it.icon}</span>
          <span style={{ flex: 1 }}>{it.label}</span>
          {it.kbd && <span style={{ fontSize: 10, color: t.textMuted, fontFamily: HV2_MONO }}>{it.kbd}</span>}
        </button>
      ))}
    </div>
  );
}

// ── Node table ─────────────────────────────────────────────────────────────
function HV2NodeTable({ nodes, t, theme }) {
  return (
    <div style={{ padding: 22, display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(360px, 1fr))', gap: 12 }}>
      {nodes.map(n => {
        const cpuColor = n.cpu > 0.8 ? '#f43f5e' : n.cpu > 0.65 ? '#f59e0b' : '#10b981';
        const memColor = n.mem > 0.8 ? '#f43f5e' : n.mem > 0.65 ? '#f59e0b' : '#10b981';
        return (
          <div key={n.name} style={{ border: `1px solid ${t.border}`, borderRadius: 9, background: t.surface, padding: 14 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10, gap: 8 }}>
              <div style={{ fontFamily: HV2_MONO, fontSize: 12, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis' }}>{n.name}</div>
              <StatusPill status={n.status} theme={theme} dense />
            </div>
            <div style={{ display: 'flex', gap: 10, fontSize: 11, color: t.textMuted, marginBottom: 12, fontFamily: HV2_MONO }}>
              <span style={{ padding: '1px 6px', borderRadius: 3, background: t.chip, fontWeight: 500 }}>{n.role}</span>
              <span>{n.instance}</span>
              <span style={{ marginLeft: 'auto' }}>{n.pods} pods</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <HV2Bar label="CPU" value={n.cpu} color={cpuColor} t={t} />
              <HV2Bar label="MEM" value={n.mem} color={memColor} t={t} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function HV2Bar({ label, value, color, t }) {
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10.5, color: t.textMuted, marginBottom: 3, fontFamily: HV2_MONO, fontWeight: 600 }}>
        <span>{label}</span>
        <span style={{ color: t.textDim }}>{Math.round(value*100)}%</span>
      </div>
      <div style={{ height: 5, borderRadius: 3, background: t.borderSoft, overflow: 'hidden' }}>
        <div style={{ width: `${value*100}%`, height: '100%', background: color, transition: 'width .3s' }} />
      </div>
    </div>
  );
}

// ── ConfigMap table ────────────────────────────────────────────────────────
function HV2CMTable({ cms, t }) {
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
      <thead>
        <tr style={{ borderBottom: `1px solid ${t.border}` }}>
          {['Name', 'Namespace', 'Keys', 'Size', 'Age'].map(h => (
            <th key={h} style={{ padding: '12px 18px', textAlign: 'left', fontSize: 11, fontWeight: 600, color: t.textMuted, letterSpacing: 0.3, textTransform: 'uppercase' }}>{h}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {cms.map(cm => (
          <tr key={cm.name + cm.ns} style={{ borderBottom: `1px solid ${t.borderSoft}` }}>
            <td style={{ padding: '11px 18px', fontFamily: HV2_MONO, fontSize: 11.5, fontWeight: 500 }}>{cm.name}</td>
            <td style={{ padding: '11px 18px', color: t.textDim }}>{cm.ns}</td>
            <td style={{ padding: '11px 18px', fontVariantNumeric: 'tabular-nums' }}>{cm.keys}</td>
            <td style={{ padding: '11px 18px', fontFamily: HV2_MONO, fontSize: 11.5, color: t.textDim }}>{cm.size}</td>
            <td style={{ padding: '11px 18px', color: t.textMuted, fontVariantNumeric: 'tabular-nums' }}>{cm.age}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ── Overlay pod detail ─────────────────────────────────────────────────────
function HV2PodDetailOverlay({ pod, cluster, t, theme, onClose }) {
  return (
    <>
      <div onClick={onClose} style={{
        position: 'absolute', inset: 0, background: t.scrim,
        zIndex: 10, animation: 'hv2-fade .18s ease',
      }} />
      <div style={{
        position: 'absolute', top: 0, right: 0, bottom: 0, width: 680,
        background: t.surface, borderLeft: `1px solid ${t.border}`,
        boxShadow: '-12px 0 32px rgba(0,0,0,0.12)',
        display: 'flex', flexDirection: 'column', zIndex: 11,
        animation: 'hv2-slide .22s cubic-bezier(.2,.7,.2,1)',
      }}>
        <div style={{ padding: '18px 22px 14px', borderBottom: `1px solid ${t.borderSoft}`, display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
              <span style={{ fontSize: 10.5, color: t.textMuted, textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 600 }}>Pod</span>
              <span style={{ fontSize: 10.5, color: t.textMuted }}>·</span>
              <span style={{ fontSize: 11, color: t.textDim }}>{cluster.name}</span>
              <span style={{ fontSize: 10.5, color: t.textMuted }}>/</span>
              <span style={{ fontSize: 11, color: t.textDim }}>{pod.ns}</span>
            </div>
            <div style={{ fontSize: 16, fontWeight: 600, fontFamily: HV2_MONO, wordBreak: 'break-all', lineHeight: 1.3 }}>{pod.name}</div>
            <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <StatusPill status={pod.status} theme={theme} pod={pod} />
              <ContainerDots containers={pod.containers} theme={theme} size={9} />
              <span style={{ fontSize: 11.5, color: t.textMuted }}>Ready {pod.ready} · {pod.restarts} restarts · {pod.age} old</span>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 4 }}>
            <IconBtn t={t} title="Copy name">{Icons.copy}</IconBtn>
            <IconBtn t={t} title="Close (Esc)" onClick={onClose}>{Icons.close}</IconBtn>
          </div>
        </div>

        <div style={{ flex: 1, overflow: 'auto', padding: '18px 22px 22px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 10, marginBottom: 22 }}>
            {[
              ['CPU', pod.cpu + 'm', pod.cpu / 500],
              ['Memory', fmtMi(pod.mem), pod.mem / 2048],
              ['Restarts', pod.restarts, Math.min(1, pod.restarts / 20)],
              ['Age', pod.age, null],
            ].map(([k, v, ratio]) => (
              <div key={k} style={{ background: t.surfaceAlt, border: `1px solid ${t.borderSoft}`, borderRadius: 8, padding: '10px 12px' }}>
                <div style={{ fontSize: 10.5, color: t.textMuted, textTransform: 'uppercase', letterSpacing: 0.4, fontWeight: 600, marginBottom: 4 }}>{k}</div>
                <div style={{ fontSize: 16, fontWeight: 600, fontFamily: HV2_MONO, fontVariantNumeric: 'tabular-nums' }}>{v}</div>
                {ratio != null && (
                  <div style={{ height: 3, borderRadius: 2, background: t.borderSoft, marginTop: 8, overflow: 'hidden' }}>
                    <div style={{ width: `${Math.min(100, ratio*100)}%`, height: '100%', background: ratio > 0.8 ? '#f43f5e' : ratio > 0.5 ? '#f59e0b' : t.accent }} />
                  </div>
                )}
              </div>
            ))}
          </div>

          <HV2Section t={t} title="Specification" />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px 20px', marginBottom: 22 }}>
            {[['Namespace', pod.ns], ['Node', pod.node], ['Cluster', cluster.name], ['Region', cluster.region]].map(([k, v]) => (
              <div key={k}>
                <div style={{ fontSize: 10.5, color: t.textMuted, textTransform: 'uppercase', letterSpacing: 0.4, fontWeight: 600, marginBottom: 3 }}>{k}</div>
                <div style={{ fontSize: 12.5, fontFamily: HV2_MONO }}>{v}</div>
              </div>
            ))}
          </div>

          <HV2Section t={t} title="Containers" right={<span style={{ fontSize: 10.5, color: t.textMuted }}>{pod.containers?.length || 0} total</span>} />
          <div style={{ marginBottom: 22 }}>
            <ContainersList containers={pod.containers} theme={theme} t={t} mono={HV2_MONO} />
          </div>

          <HV2Section t={t} title="Image" />
          <div style={{
            background: t.surfaceAlt, border: `1px solid ${t.borderSoft}`,
            padding: '10px 12px', borderRadius: 7, marginBottom: 22,
            fontFamily: HV2_MONO, fontSize: 11.5, wordBreak: 'break-all', display: 'flex', alignItems: 'center', gap: 10,
          }}>
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke={t.textMuted} strokeWidth="1.5" style={{ flexShrink: 0 }}><rect x="2" y="3" width="10" height="8" rx="1.5"/><path d="M2 6.5h10"/></svg>
            <span style={{ flex: 1 }}>{pod.image}</span>
          </div>

          <HV2Section t={t} title="Recent logs" right={<span style={{ color: t.accent, cursor: 'pointer', fontWeight: 500 }}>Tail live →</span>} />
          <div style={{
            background: theme === 'dark' ? '#0a0c10' : '#1a1d23', color: '#cbd5e1',
            padding: 12, borderRadius: 7, marginBottom: 22,
            fontFamily: HV2_MONO, fontSize: 11, lineHeight: 1.65,
            maxHeight: 200, overflow: 'auto',
          }}>
            <LogLine ts="14:22:01" lvl="INFO" lvlColor="#10b981" msg="server listening on :8080" />
            <LogLine ts="14:22:03" lvl="INFO" lvlColor="#10b981" msg={`connected to postgres://${cluster.region}-db`} />
            <LogLine ts="14:24:18" lvl="INFO" lvlColor="#10b981" msg="processed 142 requests in 30s" />
            <LogLine ts="14:24:32" lvl="WARN" lvlColor="#f59e0b" msg="slow query: SELECT * FROM orders WHERE … (412ms)" />
            {pod.status !== 'Running' && (
              <>
                <LogLine ts="14:24:42" lvl="ERROR" lvlColor="#f43f5e" msg="connection refused: fraud-api:9000" />
                <LogLine ts="14:24:43" lvl="FATAL" lvlColor="#f43f5e" msg="exiting after 3 retries" />
              </>
            )}
          </div>

          <div style={{ display: 'flex', gap: 8 }}>
            <Btn variant="secondary" t={t} icon={Icons.yaml}>View YAML</Btn>
            <Btn variant="secondary" t={t} icon={Icons.logs}>Logs</Btn>
            <Btn variant="secondary" t={t} icon={Icons.eye}>Describe</Btn>
            <div style={{ flex: 1 }} />
            <Btn variant="primary" t={t} icon={Icons.shell}>Exec shell</Btn>
          </div>
        </div>
      </div>
    </>
  );
}

function LogLine({ ts, lvl, lvlColor, msg }) {
  return (
    <div><span style={{ color: '#64748b' }}>{ts}</span> <span style={{ color: lvlColor, fontWeight: 600 }}>{lvl}</span> {msg}</div>
  );
}

function HV2Section({ t, title, right }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 11, fontWeight: 700, color: t.textDim, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 10 }}>
      <span>{title}</span>
      {right}
    </div>
  );
}

// ── Command palette ────────────────────────────────────────────────────────
function HV2Palette({ t, q, setQ, cluster, activeCluster, onPick, onClose,
                     setActiveCluster, setActiveTab, setSelectedPod, setActiveNs }) {
  const [hi, setHi] = React.useState(0);
  const inputRef = React.useRef(null);
  React.useEffect(() => { inputRef.current?.focus(); }, []);
  React.useEffect(() => { setHi(0); }, [q]);

  const items = React.useMemo(() => {
    const list = [];
    CLUSTERS.forEach(c => {
      list.push({
        id: 'cluster-' + c.id, group: 'Switch cluster',
        icon: <span style={{
          width: 8, height: 8, borderRadius: 4,
          background: c.status === 'healthy' ? '#10b981' : c.status === 'degraded' ? '#f59e0b' : '#f43f5e',
        }} />,
        label: c.name, sub: `${c.region} · ${c.pods} pods · ${c.env}`,
        keywords: [c.name, c.region, c.provider, c.env, c.id].join(' ').toLowerCase(),
        action: () => { setActiveCluster(c.id); setActiveTab('pods'); setSelectedPod(null); setActiveNs(new Set()); },
      });
    });
    if (cluster) {
      [['pods', 'Pods'], ['nodes', 'Nodes'], ['configmaps', 'ConfigMaps']].forEach(([id, label]) => {
        list.push({
          id: 'tab-' + id, group: 'Go to · ' + cluster.name,
          icon: <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="6.5" cy="6.5" r="4.5"/></svg>,
          label, sub: 'Resource',
          keywords: (label + ' ' + id).toLowerCase(),
          action: () => { setActiveTab(id); setSelectedPod(null); },
        });
      });
      (PODS_BY_CLUSTER[cluster.id] || []).forEach(p => {
        list.push({
          id: 'pod-' + p.name, group: 'Pods · ' + cluster.name,
          icon: <span style={{
            width: 7, height: 7, borderRadius: 3.5,
            background: p.status === 'Running' ? '#10b981' : p.status === 'Pending' ? '#f59e0b' : '#f43f5e',
          }} />,
          label: p.name, sub: `${p.ns} · ${p.status} · ${p.node}`,
          keywords: (p.name + ' ' + p.ns + ' ' + p.image + ' ' + p.status).toLowerCase(),
          action: () => { setActiveTab('pods'); setSelectedPod(p); },
        });
      });
    }
    return list;
  }, [cluster, activeCluster]);

  const filtered = React.useMemo(() => {
    if (!q.trim()) return items.slice(0, 14);
    const needle = q.toLowerCase();
    return items.filter(i => i.keywords.includes(needle) || i.label.toLowerCase().includes(needle)).slice(0, 16);
  }, [q, items]);

  const groups = React.useMemo(() => {
    const m = new Map();
    filtered.forEach((it, idx) => {
      if (!m.has(it.group)) m.set(it.group, []);
      m.get(it.group).push({ ...it, _idx: idx });
    });
    return [...m.entries()];
  }, [filtered]);

  const onKey = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setHi(h => Math.min(filtered.length - 1, h + 1)); }
    if (e.key === 'ArrowUp')   { e.preventDefault(); setHi(h => Math.max(0, h - 1)); }
    if (e.key === 'Enter')     { e.preventDefault(); const sel = filtered[hi]; if (sel) onPick(sel.action); }
  };

  return (
    <>
      <div onClick={onClose} style={{
        position: 'absolute', inset: 0, background: 'rgba(8,10,14,0.32)',
        backdropFilter: 'blur(2px)', zIndex: 20,
      }} />
      <div style={{
        position: 'absolute', top: '14%', left: '50%', transform: 'translateX(-50%)',
        width: 580, maxHeight: '70%', display: 'flex', flexDirection: 'column',
        background: t.paletteBg, border: `1px solid ${t.paletteBorder}`,
        borderRadius: 12, boxShadow: '0 24px 56px rgba(0,0,0,0.25)',
        backdropFilter: 'blur(20px)', zIndex: 21, overflow: 'hidden',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 18px', borderBottom: `1px solid ${t.borderSoft}` }}>
          <span style={{ color: t.textMuted, display: 'inline-flex' }}>{Icons.search}</span>
          <input ref={inputRef} value={q} onChange={e => setQ(e.target.value)} onKeyDown={onKey}
            placeholder={cluster ? `Search in ${cluster.name}, switch cluster, jump to resource…` : 'Search clusters, type a name…'}
            style={{
              flex: 1, border: 'none', outline: 'none', background: 'transparent',
              color: t.text, fontSize: 14, fontFamily: 'inherit',
            }} />
          <span style={{ fontSize: 10.5, color: t.textMuted, fontFamily: HV2_MONO, padding: '2px 6px', borderRadius: 4, background: t.chip }}>esc</span>
        </div>

        <div style={{ flex: 1, overflow: 'auto', padding: '8px 0' }}>
          {filtered.length === 0 && (
            <div style={{ padding: '32px 20px', textAlign: 'center', color: t.textMuted, fontSize: 13 }}>
              No matches for "<span style={{ color: t.textDim }}>{q}</span>"
            </div>
          )}
          {groups.map(([groupName, list]) => (
            <div key={groupName} style={{ marginBottom: 4 }}>
              <div style={{
                fontSize: 10, fontWeight: 700, color: t.textMuted,
                textTransform: 'uppercase', letterSpacing: 0.5,
                padding: '8px 18px 4px',
              }}>{groupName}</div>
              {list.map(it => {
                const isHi = filtered[hi]?.id === it.id;
                return (
                  <button key={it.id} onClick={() => onPick(it.action)}
                    onMouseEnter={() => setHi(it._idx)}
                    style={{
                      width: '100%', display: 'flex', alignItems: 'center', gap: 12,
                      padding: '8px 18px', border: 'none',
                      background: isHi ? t.accentSoft : 'transparent',
                      color: 'inherit', cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left',
                    }}>
                    <div style={{ width: 16, display: 'flex', alignItems: 'center', justifyContent: 'center', color: isHi ? t.accent : t.textMuted, flexShrink: 0 }}>
                      {it.icon}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 500, fontFamily: it.id.startsWith('pod-') ? HV2_MONO : 'inherit', color: t.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.label}</div>
                      <div style={{ fontSize: 11, color: t.textMuted, marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.sub}</div>
                    </div>
                    {isHi && (
                      <span style={{ fontSize: 10, color: t.textMuted, fontFamily: HV2_MONO }}>↵</span>
                    )}
                  </button>
                );
              })}
            </div>
          ))}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '10px 18px', borderTop: `1px solid ${t.borderSoft}`, fontSize: 10.5, color: t.textMuted }}>
          <span><kbd style={pkbd(t)}>↑↓</kbd> navigate</span>
          <span><kbd style={pkbd(t)}>↵</kbd> select</span>
          <span><kbd style={pkbd(t)}>esc</kbd> close</span>
          <div style={{ flex: 1 }} />
          <span style={{ fontFamily: HV2_MONO }}>helmsman ⌘K</span>
        </div>
      </div>
    </>
  );
}

function pkbd(t) {
  return {
    fontFamily: HV2_MONO, fontSize: 10, padding: '1px 5px', borderRadius: 3,
    background: t.chip, color: t.textDim, marginRight: 4,
  };
}

// ── Namespace modal ────────────────────────────────────────────────────────
// Multi-select with search. Empty selection means "all namespaces". The trigger
// button in the cluster bar shows a summary (single name, count, or "All").
function HV2NamespaceModal({ t, theme, cluster, activeNs, setActiveNs, onClose }) {
  const [q, setQ] = React.useState('');
  const [draft, setDraft] = React.useState(new Set(activeNs));
  const inputRef = React.useRef(null);
  React.useEffect(() => { inputRef.current?.focus(); }, []);

  const list = cluster.namespaces;
  const filtered = q.trim()
    ? list.filter(n => n.toLowerCase().includes(q.toLowerCase()))
    : list;

  const allMode = draft.size === 0;
  const toggleNs = (ns) => {
    setDraft(prev => {
      const next = new Set(prev);
      if (next.has(ns)) next.delete(ns); else next.add(ns);
      return next;
    });
  };
  const selectAll = () => setDraft(new Set());
  const apply = () => { setActiveNs(draft); onClose(); };
  const reset = () => setDraft(new Set());

  // Pod counts per namespace, for quick context.
  const pods = window.PODS_BY_CLUSTER ? (window.PODS_BY_CLUSTER[cluster.id] || []) : [];
  const counts = React.useMemo(() => {
    const m = {};
    pods.forEach(p => { m[p.ns] = (m[p.ns] || 0) + 1; });
    return m;
  }, [cluster.id]);

  const onKey = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); apply(); }
  };

  return (
    <>
      <div onClick={onClose} style={{
        position: 'absolute', inset: 0, background: 'rgba(8,10,14,0.32)',
        backdropFilter: 'blur(2px)', zIndex: 25,
      }} />
      <div onKeyDown={onKey} style={{
        position: 'absolute', top: '15%', left: '50%', transform: 'translateX(-50%)',
        width: 460, maxHeight: '70%', display: 'flex', flexDirection: 'column',
        background: t.surface, border: `1px solid ${t.border}`,
        borderRadius: 12, boxShadow: '0 24px 56px rgba(0,0,0,0.28)',
        zIndex: 26, overflow: 'hidden',
      }}>
        {/* Header */}
        <div style={{ padding: '14px 18px 12px', borderBottom: `1px solid ${t.borderSoft}` }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, letterSpacing: -0.2 }}>Filter by namespace</div>
              <div style={{ fontSize: 11.5, color: t.textMuted, marginTop: 2 }}>
                {cluster.name} · {list.length} available
              </div>
            </div>
            <button onClick={onClose} style={{
              border: 'none', background: 'transparent', cursor: 'pointer',
              color: t.textMuted, padding: 4, borderRadius: 4, display: 'flex',
            }}>
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
                <path d="M3 3l8 8M11 3l-8 8"/>
              </svg>
            </button>
          </div>
          {/* Search */}
          <div style={{ position: 'relative' }}>
            <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke={t.textMuted} strokeWidth="1.6"
              style={{ position: 'absolute', left: 9, top: '50%', transform: 'translateY(-50%)' }}>
              <circle cx="6" cy="6" r="4"/><path d="M9.2 9.2l3 3"/>
            </svg>
            <input ref={inputRef} value={q} onChange={e => setQ(e.target.value)}
              placeholder="Search namespaces…"
              style={{
                width: '100%', boxSizing: 'border-box',
                padding: '7px 10px 7px 28px',
                background: t.surfaceAlt, border: `1px solid ${t.borderSoft}`,
                borderRadius: 6, color: t.text, fontFamily: 'inherit', fontSize: 12.5, outline: 'none',
              }} />
          </div>
        </div>

        {/* "All namespaces" pseudo-row */}
        <button onClick={selectAll}
          style={{
            display: 'flex', alignItems: 'center', gap: 10,
            padding: '10px 18px', border: 'none', background: allMode ? t.accentSoft : 'transparent',
            cursor: 'pointer', textAlign: 'left', borderBottom: `1px solid ${t.borderSoft}`,
            fontFamily: 'inherit', color: t.text,
          }}
          onMouseEnter={e => { if (!allMode) e.currentTarget.style.background = t.hover; }}
          onMouseLeave={e => { if (!allMode) e.currentTarget.style.background = 'transparent'; }}>
          {/* radio-style indicator */}
          <span style={{
            width: 14, height: 14, borderRadius: '50%',
            border: `1.5px solid ${allMode ? t.accent : t.border}`,
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
          }}>
            {allMode && <span style={{ width: 7, height: 7, borderRadius: '50%', background: t.accent }} />}
          </span>
          <span style={{ fontSize: 12.5, fontWeight: 600, flex: 1 }}>All namespaces</span>
          <span style={{ fontSize: 11, color: t.textMuted, fontFamily: HV2_MONO }}>{list.length}</span>
        </button>

        {/* Namespace list */}
        <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
          {filtered.length === 0 && (
            <div style={{ padding: '24px 18px', textAlign: 'center', color: t.textMuted, fontSize: 12 }}>
              No namespaces match "{q}"
            </div>
          )}
          {filtered.map(ns => {
            const checked = draft.has(ns);
            return (
              <button key={ns} onClick={() => toggleNs(ns)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10, width: '100%',
                  padding: '8px 18px', border: 'none', background: checked ? t.accentSoft : 'transparent',
                  cursor: 'pointer', textAlign: 'left',
                  fontFamily: 'inherit', color: t.text,
                }}
                onMouseEnter={e => { if (!checked) e.currentTarget.style.background = t.hover; }}
                onMouseLeave={e => { if (!checked) e.currentTarget.style.background = 'transparent'; }}>
                {/* checkbox */}
                <span style={{
                  width: 14, height: 14, borderRadius: 3,
                  border: `1.5px solid ${checked ? t.accent : t.border}`,
                  background: checked ? t.accent : 'transparent',
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                }}>
                  {checked && (
                    <svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M2 5l2 2 4-4"/>
                    </svg>
                  )}
                </span>
                <span style={{ fontSize: 12.5, fontFamily: HV2_MONO, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ns}</span>
                <span style={{ fontSize: 10.5, color: t.textMuted, fontFamily: HV2_MONO }}>
                  {counts[ns] != null ? counts[ns] + ' pods' : '—'}
                </span>
              </button>
            );
          })}
        </div>

        {/* Footer */}
        <div style={{
          padding: '10px 14px', borderTop: `1px solid ${t.borderSoft}`,
          display: 'flex', alignItems: 'center', gap: 8, background: t.surfaceAlt,
        }}>
          <span style={{ fontSize: 11.5, color: t.textMuted, flex: 1 }}>
            {draft.size === 0 ? 'Showing all namespaces' : `${draft.size} selected`}
          </span>
          {draft.size > 0 && (
            <button onClick={reset} style={{
              border: `1px solid ${t.border}`, background: t.surface, color: t.text,
              padding: '5px 10px', borderRadius: 5, fontSize: 11.5, cursor: 'pointer', fontFamily: 'inherit',
            }}>Clear</button>
          )}
          <button onClick={apply} style={{
            border: 'none', background: t.accent, color: 'white',
            padding: '6px 14px', borderRadius: 5, fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
            display: 'inline-flex', alignItems: 'center', gap: 6,
          }}>
            Apply
            <span style={{ ...pkbd(t), background: 'rgba(255,255,255,0.18)', color: 'white', marginRight: 0 }}>↵</span>
          </button>
        </div>
      </div>
    </>
  );
}

Object.assign(window, { HV2App });
