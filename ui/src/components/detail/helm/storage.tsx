import { useEffect, useState } from "react";
import { api } from "../../../api";
import type { Tokens } from "../../../theme";
import { Notice } from "./shared";

export const CONFIGMAP_STORAGE_NOTICE =
  "Some Helm releases on this cluster use the ConfigMap storage driver and aren't listed.";

/** Warns when helm releases live in ConfigMaps, which the Secret-backed views can't show. */
export function HelmStorageNotice({ t, clusterIds }: { t: Tokens; clusterIds: string[] }) {
  const [found, setFound] = useState(false);
  const key = clusterIds.join("\u0000");
  useEffect(() => {
    let live = true;
    setFound(false);
    // A 403 on ConfigMaps means we can't tell; stay quiet rather than guess.
    for (const id of key.split("\u0000").filter(Boolean)) {
      api
        .helmStorageProbe(id)
        .then((hit) => {
          if (live && hit) setFound(true);
        })
        .catch(() => {});
    }
    return () => {
      live = false;
    };
  }, [key]);
  if (!found) return null;
  return (
    <Notice t={t} tone="warn">
      {CONFIGMAP_STORAGE_NOTICE}
    </Notice>
  );
}
