"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

type Props = {
  sessionId: string;
};

export default function DeleteSessionButton({ sessionId }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function handleDelete() {
    const ok = window.confirm(
      "确定永久删除本会话？\n\n将删除所有消息、事件与关联会话洞察，且不可恢复。"
    );
    if (!ok) return;

    setBusy(true);
    try {
      const response = await fetch(`/api/threads/${sessionId}/permanent`, {
        method: "DELETE",
      });
      if (!response.ok) {
        let detail = "删除失败";
        try {
          const j = (await response.json()) as { error?: string };
          if (j.error) detail = j.error;
        } catch {
          /* ignore */
        }
        alert(detail);
        setBusy(false);
        return;
      }
      router.push("/tavern");
      router.refresh();
    } catch {
      alert("网络错误，请稍后重试。");
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      className="button"
      disabled={busy}
      onClick={() => void handleDelete()}
      style={{
        borderColor: "var(--danger, #c44)",
        color: "var(--danger, #c44)",
      }}
    >
      {busy ? "删除中…" : "永久删除会话"}
    </button>
  );
}
