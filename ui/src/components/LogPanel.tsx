import { useCallback, useState } from "react";
import { useResolvedTheme } from "../store";
import { tokens, FF_MONO, type ThemeMode, FS_LG, FS_SM } from "../theme";
import {
  Eyebrow,
  IconBtn,
  Icons,
  Select,
  StatusPill,
  Tooltip,
} from "./ui";
import { LogView, type LogStatus, type LogViewState } from "./log/LogView";
import { streamStatusDetail, streamStatusLabel } from "./log/status";

export type LogTarget = {
  uid: string;
  namespace: string;
  name: string;
  containers: string[];
};

type Props = {
  mode: ThemeMode;
  clusterId: string;
  pod: LogTarget;
  // Optional starting container. Falls back to `pod.containers[0]` so the
  // existing call sites that don't preselect keep working.
  defaultContainer?: string | null;
  onClose: () => void;
};

// Logs panel — slides in from the right (R-09 prefers panels over modals).
// All streaming + virtualization + footer toggles live in the shared
// `LogView` component; this file owns the slide-in chrome (backdrop,
// title bar, container Select, status pill, close button).
export function LogPanel({
  mode,
  clusterId,
  pod,
  defaultContainer,
  onClose,
}: Props) {
  const t = useResolvedTheme().tokens;
  const initialContainer =
    (defaultContainer && pod.containers.includes(defaultContainer)
      ? defaultContainer
      : pod.containers[0]) ?? null;
  const [container, setContainer] = useState<string | null>(initialContainer);
  const [view, setView] = useState<LogViewState>({
    status: { kind: "starting" },
    paused: false,
    bufferedCount: 0,
    lineCount: 0,
  });
  const onStateChange = useCallback((s: LogViewState) => setView(s), []);

  return (
    <>
      <div
        onClick={onClose}
        style={{
          position: "fixed",
          top: "var(--fs-titlebar-h, 0px)",
          right: 0,
          bottom: 0,
          left: 0,
          background: t.scrim,
          zIndex: 30,
          animation: "fs-fade-in .18s ease",
        }}
      />
      <div
        style={{
          position: "fixed",
          top: "var(--fs-titlebar-h, 0px)",
          right: 0,
          bottom: 0,
          width: 680,
          maxWidth: "92vw",
          background: t.surface,
          borderLeft: `1px solid ${t.border}`,
          boxShadow:
            mode === "dark"
              ? "-12px 0 32px rgba(0,0,0,0.4)"
              : "-12px 0 32px rgba(15,20,30,0.12)",
          display: "flex",
          flexDirection: "column",
          zIndex: 31,
          animation: "fs-slide-from-right .22s cubic-bezier(.2,.7,.2,1)",
        }}
      >
        <header
          style={{
            padding: "16px 22px 12px",
            borderBottom: `1px solid ${t.borderSoft}`,
            display: "flex",
            alignItems: "flex-start",
            gap: 12,
            flexShrink: 0,
          }}
        >
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                marginBottom: 6,
              }}
            >
              <Eyebrow t={t}>Pod logs</Eyebrow>
              <span style={{ color: t.textMuted, fontSize: FS_SM }}>·</span>
              <span
                style={{
                  fontFamily: FF_MONO,
                  fontSize: FS_SM,
                  color: t.textDim,
                }}
              >
                {pod.namespace}
              </span>
            </div>
            <div
              style={{
                fontSize: FS_LG,
                fontWeight: 600,
                fontFamily: FF_MONO,
                wordBreak: "break-all",
                lineHeight: 1.3,
                color: t.text,
              }}
            >
              {pod.name}
            </div>
            <div
              style={{
                marginTop: 8,
                display: "flex",
                alignItems: "center",
                gap: 10,
                flexWrap: "wrap",
              }}
            >
              {pod.containers.length > 1 ? (
                <Select
                  t={t}
                  fullWidth={false}
                  value={container ?? ""}
                  onChange={(v) => setContainer(v)}
                  options={pod.containers.map((c) => ({ value: c, label: c }))}
                  style={{
                    fontFamily: FF_MONO,
                    fontSize: FS_SM,
                    height: 26,
                    padding: "3px 28px 3px 8px",
                  }}
                />
              ) : (
                <span
                  style={{
                    fontSize: FS_SM,
                    color: t.textMuted,
                    fontFamily: FF_MONO,
                  }}
                >
                  container: {container ?? "—"}
                </span>
              )}
              <StreamStatus
                status={view.status}
                paused={view.paused}
                bufferedCount={view.bufferedCount}
                t={t}
                mode={mode}
              />
            </div>
          </div>
          <IconBtn t={t} title="Close (Esc)" onClick={onClose}>
            {Icons.close}
          </IconBtn>
        </header>

        <LogView
          t={t}
          clusterId={clusterId}
          namespace={pod.namespace}
          pod={pod.name}
          container={container}
          onStateChange={onStateChange}
        />
      </div>
    </>
  );
}

function StreamStatus({
  status,
  paused,
  bufferedCount,
  t,
  mode,
}: {
  status: LogStatus;
  paused: boolean;
  bufferedCount: number;
  t: ReturnType<typeof tokens>;
  mode: ThemeMode;
}) {
  if (paused) {
    return (
      <span
        style={{
          fontSize: FS_SM,
          color: t.warn,
          fontFamily: FF_MONO,
        }}
      >
        {streamStatusLabel(status, paused, bufferedCount)}
      </span>
    );
  }
  if (status.kind === "starting")
    return <StatusPill status="Pending" t={t} mode={mode} dense />;
  if (status.kind === "streaming")
    return <StatusPill status="Running" t={t} mode={mode} dense />;
  if (status.kind === "error")
    return <StatusPill status="Error" t={t} mode={mode} dense />;
  // `waiting` / `ended`: keep the chrome label terse — the full reason
  // already lives in the log body, so it's a hover tooltip here, not an
  // inlined duplicate.
  const detail = streamStatusDetail(status);
  return (
    <Tooltip label={detail ?? ""}>
      <span
        style={{
          fontSize: FS_SM,
          color: status.kind === "waiting" ? t.warn : t.textMuted,
          fontFamily: FF_MONO,
        }}
      >
        {streamStatusLabel(status, paused, bufferedCount)}
      </span>
    </Tooltip>
  );
}
