"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

type Props = {
  worldId: string;
  fromVersionId: string;
  fromVersionNumber: number;
};

export default function RestoreVersionButton({
  worldId,
  fromVersionId,
  fromVersionNumber,
}: Props) {
  const router = useRouter();
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  async function handleRestore() {
    if (
      !confirm(
        `将基于 v${fromVersionNumber} 的设定追加一个新版本号（不删除任何历史）。确定？`
      )
    ) {
      return;
    }
    setBusy(true);
    setStatus("");
    try {
      const response = await fetch(`/api/worlds/${worldId}/versions/restore`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fromVersionId }),
      });
      const payload = (await response.json()) as {
        error?: string;
        version?: { version: number };
      };
      if (!response.ok) {
        setStatus(payload.error ?? "恢复失败");
        return;
      }
      setStatus(`已创建 v${payload.version?.version ?? "?"}，列表已刷新`);
      router.refresh();
    } catch {
      setStatus("网络错误");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ marginTop: "0.35rem" }}>
      <button
        type="button"
        className="button"
        disabled={busy}
        onClick={() => {
          void handleRestore();
        }}
      >
        {busy ? "处理中…" : "基于此版本恢复为新版本"}
      </button>
      {status ? (
        <span className="muted" style={{ marginLeft: "0.5rem", fontSize: "0.85rem" }}>
          {status}
        </span>
      ) : null}
    </div>
  );
}
