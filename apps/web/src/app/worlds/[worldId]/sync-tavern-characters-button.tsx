"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export default function SyncTavernCharactersButton({
  worldId,
  worldVersionId,
}: {
  worldId: string;
  /** 当前页正在浏览的 world_versions.id，与下拉版本一致 */
  worldVersionId: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  if (!worldVersionId) {
    return null;
  }

  return (
    <button
      type="button"
      className="button secondary"
      disabled={busy}
      onClick={() => {
        void (async () => {
          setBusy(true);
          try {
            const res = await fetch(
              `/api/worlds/${encodeURIComponent(worldId)}/sync-tavern-characters`,
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ versionId: worldVersionId }),
              }
            );
            if (!res.ok) {
              let msg = "同步失败";
              try {
                const j = (await res.json()) as { error?: string };
                if (j.error) msg = j.error;
              } catch {
                /* ignore */
              }
              window.alert(msg);
              return;
            }
            router.refresh();
            window.alert("已同步到角色库（酒馆 → 角色）。");
          } finally {
            setBusy(false);
          }
        })();
      }}
    >
      {busy ? "同步中…" : "同步角色库"}
    </button>
  );
}
