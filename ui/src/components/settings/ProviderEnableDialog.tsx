import { FS_MD, FS_SM, R_MD, hexWithAlpha, type Tokens } from "../../theme";
import { Btn, Dialog } from "../ui";
import type { EnableNotice } from "../../types";

// Disclosure shown before a provider is switched on (today: the keyless Zen
// free tier). The wording comes from the backend so it isn't a UI concern.
export function ProviderEnableDialog({
  t,
  providerName,
  notice,
  busy,
  onCancel,
  onConfirm,
}: {
  t: Tokens;
  providerName: string;
  notice: EnableNotice;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog
      t={t}
      title={notice.headline}
      subtitle={providerName}
      width={520}
      busy={busy}
      onClose={onCancel}
      footer={
        <>
          <Btn t={t} variant="ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </Btn>
          <Btn t={t} variant="primary" onClick={onConfirm} disabled={busy}>
            {busy ? "Enabling…" : "Enable"}
          </Btn>
        </>
      }
    >
      <ul
        style={{
          margin: 0,
          padding: "0 0 0 18px",
          display: "flex",
          flexDirection: "column",
          gap: 8,
          fontSize: FS_MD,
          lineHeight: 1.45,
        }}
      >
        {notice.points.map((point) => (
          <li key={point}>{point}</li>
        ))}
      </ul>
      <div
        style={{
          marginTop: 12,
          padding: "8px 10px",
          fontSize: FS_SM,
          color: t.warn,
          background: hexWithAlpha(t.warn, 0.12),
          border: `1px solid ${hexWithAlpha(t.warn, 0.4)}`,
          borderRadius: R_MD,
        }}
      >
        It stays off until you confirm here. Switch it off again any time in
        Settings → AI.{" "}
        <a
          href={notice.learn_more_url}
          target="_blank"
          rel="noreferrer"
          style={{ color: "inherit", textDecoration: "underline" }}
        >
          Privacy details
        </a>
      </div>
    </Dialog>
  );
}
