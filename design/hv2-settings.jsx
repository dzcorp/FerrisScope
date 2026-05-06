// Helmsman v2 — Settings panel (modal-style, slides in from right)

function HV2Settings({ t, theme, onClose, settings, setSettings }) {
  const [active, setActive] = React.useState('general');

  const sections = [
    { id: 'general', label: 'General' },
    { id: 'appearance', label: 'Appearance' },
    { id: 'kubeconfig', label: 'Kubeconfig' },
    { id: 'shortcuts', label: 'Shortcuts' },
    { id: 'about', label: 'About' },
  ];

  return (
    <>
      <div onClick={onClose} style={{
        position: 'absolute', inset: 0, background: t.scrim,
        zIndex: 14, animation: 'hv2-fade .15s ease',
      }} />
      <div style={{
        position: 'absolute', top: 0, right: 0, bottom: 0, width: 760,
        background: t.surface, borderLeft: `1px solid ${t.border}`,
        boxShadow: '-12px 0 32px rgba(0,0,0,0.12)',
        display: 'flex', flexDirection: 'column', zIndex: 15,
        animation: 'hv2-slide .22s cubic-bezier(.2,.7,.2,1)',
      }}>
        {/* Header */}
        <div style={{
          padding: '16px 22px', borderBottom: `1px solid ${t.borderSoft}`,
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        }}>
          <div style={{ fontSize: 15, fontWeight: 600, letterSpacing: -0.2 }}>Settings</div>
          <IconBtn t={t} title="Close (Esc)" onClick={onClose}>{Icons.close}</IconBtn>
        </div>

        {/* Body: side-tabs + content */}
        <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
          <div style={{
            width: 180, borderRight: `1px solid ${t.borderSoft}`,
            padding: '14px 10px', display: 'flex', flexDirection: 'column', gap: 1,
            background: t.surfaceAlt,
          }}>
            {sections.map(s => {
              const isActive = active === s.id;
              return (
                <button key={s.id} onClick={() => setActive(s.id)}
                  style={{
                    padding: '7px 12px', borderRadius: 6, border: 'none',
                    background: isActive ? t.surface : 'transparent',
                    color: isActive ? t.text : t.textDim,
                    fontFamily: 'inherit', fontSize: 12.5, fontWeight: isActive ? 600 : 500,
                    textAlign: 'left', cursor: 'pointer',
                    boxShadow: isActive ? `0 0 0 1px ${t.borderSoft}` : 'none',
                    transition: 'background .12s',
                  }}>
                  {s.label}
                </button>
              );
            })}
          </div>

          <div style={{ flex: 1, overflowY: 'auto', padding: '22px 28px 28px' }}>
            {active === 'general' && <SettingsGeneral t={t} settings={settings} setSettings={setSettings} />}
            {active === 'appearance' && <SettingsAppearance t={t} theme={theme} settings={settings} setSettings={setSettings} />}
            {active === 'kubeconfig' && <SettingsKubeconfig t={t} settings={settings} setSettings={setSettings} />}
            {active === 'shortcuts' && <SettingsShortcuts t={t} />}
            {active === 'about' && <SettingsAbout t={t} />}
          </div>
        </div>

        {/* Footer */}
        <div style={{
          padding: '12px 22px', borderTop: `1px solid ${t.borderSoft}`,
          display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'flex-end',
          background: t.surfaceAlt,
        }}>
          <Btn variant="ghost" t={t} onClick={onClose}>Cancel</Btn>
          <Btn variant="primary" t={t} onClick={onClose}>Save changes</Btn>
        </div>
      </div>
    </>
  );
}

// ── Settings field row primitives ─────────────────────────────────────────
function Field({ t, label, hint, children }) {
  return (
    <div style={{
      display: 'grid', gridTemplateColumns: '1fr 280px', gap: 24, alignItems: 'flex-start',
      padding: '16px 0', borderBottom: `1px solid ${t.borderSoft}`,
    }}>
      <div>
        <div style={{ fontSize: 13, fontWeight: 600, color: t.text, marginBottom: 3 }}>{label}</div>
        {hint && <div style={{ fontSize: 12, color: t.textDim, lineHeight: 1.5 }}>{hint}</div>}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>{children}</div>
    </div>
  );
}

function SectionHeader({ t, title, sub }) {
  return (
    <div style={{ marginBottom: 4 }}>
      <div style={{ fontSize: 16, fontWeight: 600, letterSpacing: -0.2, marginBottom: 2 }}>{title}</div>
      {sub && <div style={{ fontSize: 12.5, color: t.textDim }}>{sub}</div>}
    </div>
  );
}

function TextInput({ t, value, onChange, placeholder, mono, ...rest }) {
  return (
    <input value={value} onChange={(e) => onChange?.(e.target.value)} placeholder={placeholder}
      style={{
        padding: '7px 10px', height: 32,
        border: `1px solid ${t.border}`, borderRadius: 6,
        background: t.surface, color: t.text, fontSize: 12.5,
        fontFamily: mono ? HV2_MONO : 'inherit', outline: 'none',
        width: '100%',
      }}
      onFocus={e => e.currentTarget.style.borderColor = t.accent}
      onBlur={e => e.currentTarget.style.borderColor = t.border}
      {...rest}
    />
  );
}

function Select({ t, value, onChange, options }) {
  return (
    <select value={value} onChange={(e) => onChange?.(e.target.value)}
      style={{
        padding: '7px 10px', height: 32,
        border: `1px solid ${t.border}`, borderRadius: 6,
        background: t.surface, color: t.text, fontSize: 12.5,
        fontFamily: 'inherit', outline: 'none', cursor: 'pointer',
        width: '100%',
      }}>
      {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

function Toggle({ t, checked, onChange, label }) {
  return (
    <button onClick={() => onChange?.(!checked)}
      style={{
        display: 'flex', alignItems: 'center', gap: 10,
        border: 'none', background: 'transparent', cursor: 'pointer',
        padding: '4px 0', color: t.text, fontFamily: 'inherit', fontSize: 12.5,
      }}>
      <span style={{
        width: 30, height: 18, borderRadius: 9,
        background: checked ? t.accent : t.border,
        position: 'relative', transition: 'background .15s', flexShrink: 0,
      }}>
        <span style={{
          position: 'absolute', top: 2, left: checked ? 14 : 2,
          width: 14, height: 14, borderRadius: 7, background: '#fff',
          transition: 'left .15s', boxShadow: '0 1px 2px rgba(0,0,0,0.15)',
        }} />
      </span>
      {label && <span>{label}</span>}
    </button>
  );
}

// ── Sections ──────────────────────────────────────────────────────────────
function SettingsGeneral({ t, settings, setSettings }) {
  return (
    <div>
      <SectionHeader t={t} title="General" sub="Default behavior across clusters and resources." />
      <Field t={t} label="Default namespace" hint="Used when entering a cluster that doesn't have a previous selection.">
        <TextInput t={t} value={settings.defaultNs} onChange={(v) => setSettings({ defaultNs: v })} placeholder="default" mono />
      </Field>
      <Field t={t} label="Refresh interval" hint="How often resource lists refetch from the API server.">
        <Select t={t} value={String(settings.refreshSec)} onChange={(v) => setSettings({ refreshSec: Number(v) })}
          options={[
            { value: '0', label: 'Manual only' },
            { value: '5', label: 'Every 5 seconds' },
            { value: '15', label: 'Every 15 seconds' },
            { value: '30', label: 'Every 30 seconds' },
            { value: '60', label: 'Every minute' },
          ]} />
      </Field>
      <Field t={t} label="Confirm destructive actions" hint="Require an extra click before deleting pods, scaling to zero, or rolling restarts.">
        <Toggle t={t} checked={settings.confirmDestructive} onChange={(v) => setSettings({ confirmDestructive: v })}
          label={settings.confirmDestructive ? 'Enabled' : 'Disabled'} />
      </Field>
      <Field t={t} label="Show system namespaces" hint="Include kube-system, kube-public, and similar in the namespace dropdown.">
        <Toggle t={t} checked={settings.showSystemNs} onChange={(v) => setSettings({ showSystemNs: v })}
          label={settings.showSystemNs ? 'Visible' : 'Hidden'} />
      </Field>
    </div>
  );
}

function SettingsAppearance({ t, theme, settings, setSettings }) {
  const accentSwatches = [
    { key: 'teal',   color: '#0d9488' },
    { key: 'indigo', color: '#4f46e5' },
    { key: 'rose',   color: '#e11d48' },
    { key: 'amber',  color: '#d97706' },
    { key: 'slate',  color: '#475569' },
  ];
  return (
    <div>
      <SectionHeader t={t} title="Appearance" sub="Density, accent color, and theme. Theme also lives in the floating Tweaks panel." />
      <Field t={t} label="Theme" hint="Light is calmer for daytime; dark is easier on the eyes during incidents.">
        <div style={{ display: 'flex', gap: 6 }}>
          {[['light', 'Light'], ['dark', 'Dark'], ['system', 'System']].map(([v, l]) => (
            <button key={v} onClick={() => setSettings({ theme: v })}
              style={{
                flex: 1, padding: '7px 0', height: 32, borderRadius: 6,
                border: `1px solid ${theme === v ? t.accent : t.border}`,
                background: theme === v ? t.accentSoft : t.surface,
                color: theme === v ? t.accent : t.text,
                fontFamily: 'inherit', fontSize: 12, fontWeight: 500,
                cursor: 'pointer',
              }}>{l}</button>
          ))}
        </div>
      </Field>
      <Field t={t} label="Accent color" hint="Used for selection, primary buttons, and active rail items.">
        <div style={{ display: 'flex', gap: 6 }}>
          {accentSwatches.map(s => (
            <button key={s.key} onClick={() => setSettings({ accent: s.key })} title={s.key}
              style={{
                width: 28, height: 28, borderRadius: 14, border: 'none', cursor: 'pointer',
                background: s.color,
                outline: settings.accent === s.key ? `2px solid ${t.text}` : 'none',
                outlineOffset: 2, padding: 0,
              }} />
          ))}
        </div>
      </Field>
      <Field t={t} label="Density" hint="Compact fits more rows on screen; comfortable adds breathing room.">
        <Select t={t} value={settings.density} onChange={(v) => setSettings({ density: v })}
          options={[
            { value: 'compact', label: 'Compact' },
            { value: 'comfortable', label: 'Comfortable' },
            { value: 'spacious', label: 'Spacious' },
          ]} />
      </Field>
      <Field t={t} label="Mono font in tables" hint="Use a monospace font for resource names and IDs to align columns.">
        <Toggle t={t} checked={settings.monoTables} onChange={(v) => setSettings({ monoTables: v })}
          label={settings.monoTables ? 'On' : 'Off'} />
      </Field>
    </div>
  );
}

function SettingsKubeconfig({ t, settings, setSettings }) {
  return (
    <div>
      <SectionHeader t={t} title="Kubeconfig" sub="Where contexts come from and how they're refreshed." />
      <Field t={t} label="Path to kubeconfig" hint="Absolute path. Multiple files can be merged using ':' as a separator.">
        <TextInput t={t} value={settings.kubeconfigPath} onChange={(v) => setSettings({ kubeconfigPath: v })}
          placeholder="~/.kube/config" mono />
        <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
          <Btn variant="secondary" size="sm" t={t}>Browse…</Btn>
          <Btn variant="ghost" size="sm" t={t}>Reload</Btn>
        </div>
      </Field>
      <Field t={t} label="Auto-detect cloud providers" hint="Automatically import contexts from gcloud, aws eks, and az aks CLIs if installed.">
        <Toggle t={t} checked={settings.autoDetectCloud} onChange={(v) => setSettings({ autoDetectCloud: v })}
          label={settings.autoDetectCloud ? 'Enabled' : 'Disabled'} />
      </Field>
      <Field t={t} label="Context refresh on launch" hint="Re-read kubeconfig whenever Helmsman starts or returns from background.">
        <Toggle t={t} checked={settings.refreshOnLaunch} onChange={(v) => setSettings({ refreshOnLaunch: v })}
          label={settings.refreshOnLaunch ? 'Enabled' : 'Disabled'} />
      </Field>
    </div>
  );
}

function SettingsShortcuts({ t }) {
  const rows = [
    ['Open command palette', '⌘ K'],
    ['Switch cluster',        '⌘ ⇧ C'],
    ['Jump to Pods',          'g  p'],
    ['Jump to Nodes',          'g  n'],
    ['Jump to ConfigMaps',     'g  c'],
    ['Refresh current view',   '⌘ R'],
    ['Exec into selected pod', '⌘ E'],
    ['View logs',              '⌘ L'],
    ['Close panel',            'Esc'],
  ];
  return (
    <div>
      <SectionHeader t={t} title="Shortcuts" sub="Keyboard shortcuts for the most common actions." />
      <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 0 }}>
        {rows.map(([label, kbd], i) => (
          <div key={i} style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '10px 0', borderBottom: i < rows.length - 1 ? `1px solid ${t.borderSoft}` : 'none',
          }}>
            <span style={{ fontSize: 13, color: t.text }}>{label}</span>
            <span style={{ display: 'flex', gap: 4 }}>
              {kbd.split(/\s+/).map((k, j) => (
                <kbd key={j} style={{
                  fontFamily: HV2_MONO, fontSize: 11, padding: '2px 7px',
                  background: t.chip, color: t.textDim, borderRadius: 4,
                  border: `1px solid ${t.borderSoft}`, fontWeight: 500,
                }}>{k}</kbd>
              ))}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function SettingsAbout({ t }) {
  return (
    <div>
      <SectionHeader t={t} title="About" />
      <div style={{ marginTop: 18, display: 'flex', alignItems: 'center', gap: 14, marginBottom: 18 }}>
        <div style={{
          width: 44, height: 44, borderRadius: 11, background: t.accent, color: 'white',
          display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: 20, letterSpacing: -0.5,
        }}>H</div>
        <div>
          <div style={{ fontSize: 17, fontWeight: 700, letterSpacing: -0.3 }}>Helmsman</div>
          <div style={{ fontSize: 12.5, color: t.textDim, fontFamily: HV2_MONO }}>Version 0.4.2 · build 2401a · K8s 1.28+</div>
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr', gap: '10px 16px', fontSize: 12.5, color: t.textDim }}>
        <div style={{ color: t.textMuted }}>License</div><div>MIT</div>
        <div style={{ color: t.textMuted }}>Repository</div><div style={{ fontFamily: HV2_MONO }}>github.com/helmsman/desktop</div>
        <div style={{ color: t.textMuted }}>Updates</div><div>You're on the latest version.</div>
      </div>
    </div>
  );
}

Object.assign(window, { HV2Settings });
