import { useRef, useState, type ReactNode } from "react";
import Editor from "@monaco-editor/react";
import { useAppStore, useResolvedTheme } from "../../../store";
import { DETAIL_LAYOUT, FF_MONO, FS_SM, R_MD, type Tokens } from "../../../theme";
import { installClipboardShortcuts, type MonacoEditor } from "../../../lib/monacoClipboard";
import { api } from "../../../api";
import { Btn, Chip, ErrorBlock, IconBtn, Icons } from "../../ui";
import { ChipWrap, Copyable, Mute } from "..";
import type { HelmFailure } from "./useHelmRelease";

export const sectionGap = { marginBottom: DETAIL_LAYOUT.sectionGap } as const;

export function Frame({ t, children }: { t: Tokens; children: ReactNode }) {
  return (
    <div
      style={{
        height: "100%",
        overflow: "auto",
        padding: DETAIL_LAYOUT.padding,
        background: t.bg,
        color: t.text,
        overflowWrap: "anywhere",
      }}
    >
      {children}
    </div>
  );
}

export function Notice({
  t,
  tone,
  children,
  actions,
}: {
  t: Tokens;
  tone: "warn" | "bad";
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div
      role={tone === "bad" ? "alert" : "status"}
      style={{
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        gap: DETAIL_LAYOUT.itemGap,
        marginBottom: DETAIL_LAYOUT.itemGap,
        padding: "8px 10px",
        background: tone === "warn" ? t.warnSoft : t.surface,
        border: `1px solid ${tone === "warn" ? t.warn : t.bad}`,
        borderRadius: R_MD,
        color: tone === "warn" ? t.warn : t.bad,
        fontSize: FS_SM,
      }}
    >
      <span style={{ flex: "1 1 220px", minWidth: 0 }}>{children}</span>
      {actions}
    </div>
  );
}

export function HelmMissingNotice({ t, what }: { t: Tokens; what: string }) {
  const openSettings = useAppStore((s) => s.openSettings);
  return (
    <Notice
      t={t}
      tone="warn"
      actions={
        <Btn t={t} size="sm" variant="ghost" onClick={() => openSettings({ section: "tools", anchor: "helm" })}>
          Set up helm…
        </Btn>
      }
    >
      helm CLI not found — {what} are disabled.
    </Notice>
  );
}

/** Failed helm run: friendly error plus the raw stderr, dismissible. */
export function FailureBlock({
  t,
  failure,
  kindLabel,
  onDismiss,
}: {
  t: Tokens;
  failure: HelmFailure;
  kindLabel: string;
  onDismiss: () => void;
}) {
  return (
    <section
      aria-label={failure.title}
      style={{
        marginBottom: DETAIL_LAYOUT.sectionGap,
        padding: "8px 10px",
        border: `1px solid ${t.bad}`,
        borderRadius: R_MD,
        background: t.surface,
      }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <ErrorBlock t={t} message={failure.message} kindLabel={kindLabel} verb="save" inline />
        </div>
        <IconBtn t={t} title="Dismiss" onClick={onDismiss}>
          {Icons.close}
        </IconBtn>
      </div>
      {failure.stderr.trim() && (
        <pre
          className="fs-selectable"
          style={{
            margin: "6px 0 0",
            padding: "8px 10px",
            background: t.surfaceAlt,
            border: `1px solid ${t.borderSoft}`,
            borderRadius: R_MD,
            fontFamily: FF_MONO,
            fontSize: FS_SM,
            color: t.text,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            maxHeight: 200,
            overflow: "auto",
          }}
        >
          {failure.stderr}
        </pre>
      )}
    </section>
  );
}

/**
 * Monaco YAML block. Read-only mode sits behind a click-to-activate overlay so
 * wheel events over a stack of editors scroll the panel, not the editor.
 */
export function YamlEditor({
  t,
  value,
  onChange,
  height,
  readOnly,
  emptyLabel,
  label,
}: {
  t: Tokens;
  value: string;
  onChange?: (v: string) => void;
  height: number;
  readOnly: boolean;
  emptyLabel?: string;
  label: string;
}) {
  const { mode, typography } = useResolvedTheme();
  const [active, setActive] = useState(false);
  const editorRef = useRef<MonacoEditor | null>(null);
  if (readOnly && emptyLabel && !value.trim()) return <Mute t={t}>{emptyLabel}</Mute>;
  const overlay = readOnly && !active;
  return (
    <div
      aria-label={label}
      style={{
        position: "relative",
        border: `1px solid ${!readOnly || active ? t.accent : t.border}`,
        borderRadius: R_MD,
        overflow: "hidden",
      }}
    >
      <Editor
        height={height}
        language="yaml"
        theme={mode === "dark" ? "vs-dark" : "light"}
        value={value}
        onChange={(next) => onChange?.(next ?? "")}
        onMount={(editor, monaco) => {
          editorRef.current = editor;
          installClipboardShortcuts(editor, monaco);
          editor.onDidBlurEditorWidget(() => setActive(false));
        }}
        options={{
          readOnly,
          domReadOnly: readOnly,
          minimap: { enabled: false },
          fontSize: typography.scale.md,
          fontFamily: typography.fontMono,
          wordWrap: "on",
          scrollBeyondLastLine: false,
          renderLineHighlight: readOnly ? "none" : "line",
          folding: true,
          lineNumbers: "on",
          scrollbar: { alwaysConsumeMouseWheel: false },
        }}
      />
      {overlay && (
        <button
          type="button"
          onClick={() => {
            setActive(true);
            setTimeout(() => editorRef.current?.focus(), 0);
          }}
          onMouseDown={(e) => e.preventDefault()}
          aria-label={`Interact with ${label}`}
          title="Click to interact · scroll outside to scroll the page"
          style={{
            position: "absolute",
            inset: 0,
            cursor: "pointer",
            background: "transparent",
            border: "none",
            padding: 0,
            zIndex: 20,
          }}
        />
      )}
    </div>
  );
}

export function ExternalLinks({ t, urls }: { t: Tokens; urls: string[] }) {
  return (
    <ChipWrap>
      {urls.map((u) => (
        <span key={u} style={{ display: "inline-flex", alignItems: "center", gap: 2, minWidth: 0 }}>
          <Btn t={t} size="sm" variant="ghost" icon={Icons.external} title={`Open ${u}`} onClick={() => void api.openExternal(u)}>
            {u.replace(/^https?:\/\//, "")}
          </Btn>
          <IconBtn t={t} title={`Copy ${u}`} onClick={() => void navigator.clipboard?.writeText(u)}>
            {Icons.copy}
          </IconBtn>
        </span>
      ))}
    </ChipWrap>
  );
}

export function Keywords({ t, keywords }: { t: Tokens; keywords: string[] }) {
  return (
    <ChipWrap>
      {keywords.map((k) => (
        <Copyable key={k} text={k}>
          <Chip t={t} mono>
            {k}
          </Chip>
        </Copyable>
      ))}
    </ChipWrap>
  );
}
