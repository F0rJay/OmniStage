"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * 创建空世界并跳转编剧工坊（?new=1），与导入并列的「从零对话」入口。
 */
export default function NewWorldLauncher() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function create() {
    setErr(null);
    setBusy(true);
    try {
      const trimmed = name.trim();
      const res = await fetch("/api/worlds", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: trimmed || "未命名世界",
          description: "",
        }),
      });
      const data = (await res.json()) as { error?: string; world?: { id: string } };
      if (!res.ok) {
        setErr(data.error ?? "创建失败");
        return;
      }
      const id = data.world?.id;
      if (!id) {
        setErr("响应无效");
        return;
      }
      router.push(`/worlds/${id}/workshop?new=1`);
    } catch {
      setErr("网络错误");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="row"
      style={{
        flexWrap: "wrap",
        gap: "0.5rem",
        alignItems: "center",
        margin: 0,
      }}
    >
      <input
        type="text"
        className="input"
        aria-label="新世界名称"
        placeholder="世界名称（可选）"
        value={name}
        onChange={(e) => setName(e.target.value)}
        style={{ minWidth: "11rem", flex: "1 1 10rem", maxWidth: "20rem" }}
        disabled={busy}
      />
      <button
        type="button"
        className="button"
        disabled={busy}
        onClick={() => void create()}
      >
        {busy ? "创建中…" : "新建世界"}
      </button>
      {err ? (
        <span className="muted" style={{ color: "var(--danger)", fontSize: "0.85rem" }}>
          {err}
        </span>
      ) : null}
    </div>
  );
}
