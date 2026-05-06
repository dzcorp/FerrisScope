// Helmsman v2 — Auto-hide grouped left rail

function HV2Rail({ t, activeTab, setActiveTab, cluster, open, pinned, setPinned, setHover, onSettings }) {
  const groups = [
    {
      label: 'Workloads',
      items: [
        { id: 'pods', label: 'Pods', count: (PODS_BY_CLUSTER[cluster.id] || []).length, icon: Icons.pod },
        { id: 'deployments', label: 'Deployments', count: Math.round((PODS_BY_CLUSTER[cluster.id] || []).length / 3) || 0, icon: Icons.deploy },
      ],
    },
    {
      label: 'Cluster',
      items: [
        { id: 'nodes', label: 'Nodes', count: (NODES_BY_CLUSTER[cluster.id] || []).length, icon: Icons.node },
      ],
    },
    {
      label: 'Configuration',
      items: [
        { id: 'configmaps', label: 'ConfigMaps', count: (CONFIGMAPS_BY_CLUSTER[cluster.id] || []).length, icon: Icons.cm },
        { id: 'secrets', label: 'Secrets', count: Math.max(2, Math.round(((CONFIGMAPS_BY_CLUSTER[cluster.id] || []).length) / 2)), icon: Icons.secret },
      ],
    },
  ];

  const W_COLLAPSED = 56;
  const W_OPEN = 212;

  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        position: 'absolute', top: 0, bottom: 0, left: 0,
        width: open ? W_OPEN : W_COLLAPSED,
        background: t.rail,
        borderRight: `1px solid ${t.border}`,
        boxShadow: open && !pinned ? '4px 0 16px rgba(15,20,30,0.08)' : 'none',
        display: 'flex', flexDirection: 'column',
        transition: 'width .18s cubic-bezier(.2,.7,.2,1), box-shadow .18s',
        overflow: 'hidden',
        zIndex: 8,
      }}>
      <div style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', padding: '10px 0 8px' }}>
        {groups.map((g, gi) => (
          <div key={g.label} style={{ marginBottom: 8 }}>
            <div style={{
              fontSize: 10, fontWeight: 700, color: t.textMuted,
              textTransform: 'uppercase', letterSpacing: 0.6,
              padding: '6px 16px 4px',
              opacity: open ? 1 : 0,
              transition: 'opacity .15s',
              whiteSpace: 'nowrap',
              height: open ? 'auto' : (gi === 0 ? 0 : 8),
            }}>{g.label}</div>
            <div style={{ padding: '0 8px', display: 'flex', flexDirection: 'column', gap: 1 }}>
              {g.items.map(item => {
                const isActive = activeTab === item.id;
                return (
                  <button key={item.id} onClick={() => setActiveTab(item.id)} title={!open ? item.label : undefined}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 11,
                      padding: '7px 10px', borderRadius: 7,
                      border: 'none', cursor: 'pointer', fontFamily: 'inherit',
                      background: isActive ? t.accentSoft : 'transparent',
                      color: isActive ? t.accent : t.textDim,
                      width: '100%', minHeight: 32,
                      position: 'relative',
                      transition: 'background .12s',
                    }}
                    onMouseEnter={e => { if (!isActive) e.currentTarget.style.background = t.railHover; }}
                    onMouseLeave={e => { if (!isActive) e.currentTarget.style.background = 'transparent'; }}>
                    {isActive && <div style={{ position: 'absolute', left: -8, top: 6, bottom: 6, width: 2, borderRadius: 2, background: t.accent }} />}
                    <div style={{ width: 16, height: 16, flexShrink: 0, display: 'flex' }}>{item.icon}</div>
                    <div style={{
                      flex: 1, fontSize: 12.5, fontWeight: isActive ? 600 : 500, letterSpacing: -0.1,
                      opacity: open ? 1 : 0, transition: 'opacity .15s', whiteSpace: 'nowrap',
                      textAlign: 'left',
                    }}>{item.label}</div>
                    <span style={{
                      fontSize: 10.5, padding: '1px 6px', borderRadius: 4,
                      background: isActive ? t.accentSoft : t.chip,
                      color: isActive ? t.accent : t.textMuted,
                      fontVariantNumeric: 'tabular-nums', fontWeight: 600,
                      opacity: open ? 1 : 0, transition: 'opacity .15s',
                      whiteSpace: 'nowrap',
                    }}>{item.count}</span>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      {/* Footer: Settings + pin toggle */}
      <div style={{ padding: 8, borderTop: `1px solid ${t.borderSoft}`, display: 'flex', flexDirection: 'column', gap: 1 }}>
        <button onClick={onSettings} title={!open ? 'Settings' : undefined}
          style={{
            width: '100%', display: 'flex', alignItems: 'center', gap: 11,
            padding: '7px 10px', borderRadius: 7, border: 'none',
            background: 'transparent', cursor: 'pointer', fontFamily: 'inherit',
            color: t.textDim, minHeight: 32,
          }}
          onMouseEnter={e => e.currentTarget.style.background = t.railHover}
          onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
          <div style={{ width: 16, height: 16, flexShrink: 0, display: 'flex' }}>{Icons.settings}</div>
          <span style={{ flex: 1, fontSize: 12.5, fontWeight: 500, opacity: open ? 1 : 0, whiteSpace: 'nowrap', transition: 'opacity .15s', textAlign: 'left' }}>Settings</span>
        </button>
        <button onClick={() => setPinned(p => !p)} title={pinned ? 'Unpin sidebar' : 'Pin sidebar open'}
          style={{
            width: '100%', display: 'flex', alignItems: 'center', gap: 11,
            padding: '7px 10px', borderRadius: 7, border: 'none',
            background: 'transparent', cursor: 'pointer', fontFamily: 'inherit',
            color: pinned ? t.accent : t.textMuted, minHeight: 32,
          }}
          onMouseEnter={e => e.currentTarget.style.background = t.railHover}
          onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
          <div style={{ width: 16, height: 16, flexShrink: 0, display: 'flex', transform: pinned ? 'rotate(0deg)' : 'rotate(45deg)', transition: 'transform .15s' }}>{Icons.pin}</div>
          <span style={{ fontSize: 12, fontWeight: 500, opacity: open ? 1 : 0, whiteSpace: 'nowrap', transition: 'opacity .15s', flex: 1, textAlign: 'left' }}>
            {pinned ? 'Pinned' : 'Pin sidebar'}
          </span>
        </button>
      </div>
    </div>
  );
}

Object.assign(window, { HV2Rail });
