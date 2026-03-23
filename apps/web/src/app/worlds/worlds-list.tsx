"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

export type WorldListItem = {
  id: string;
  name: string;
  description: string;
};

export default function WorldsList({ worlds }: { worlds: WorldListItem[] }) {
  const router = useRouter();
  const [deletingId, setDeletingId] = useState<string | null>(null);

  async function handleDelete(world: WorldListItem) {
    const ok = window.confirm(
      `确定删除世界「${world.name}」？\n\n将永久删除其所有版本与编剧工坊对话；酒馆里绑定该世界版本的会话会自动解除绑定。此操作不可恢复。`
    );
    if (!ok) return;

    setDeletingId(world.id);
    try {
      const res = await fetch(`/api/worlds/${world.id}`, { method: "DELETE" });
      if (!res.ok) {
        let msg = "删除失败";
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
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <ul style={{ margin: 0, paddingLeft: 0, listStyle: "none" }}>
      {worlds.map((w) => (
        <li
          key={w.id}
          style={{
            marginBottom: "0.65rem",
            padding: "0.5rem 0",
            borderBottom: "1px solid var(--border)",
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            gap: "0.5rem 0.75rem",
          }}
        >
          <Link
            href={`/worlds/${w.id}`}
            style={{ fontWeight: 600, minWidth: "8rem" }}
          >
            {w.name}
          </Link>
          <span className="muted" style={{ flex: "1 1 200px" }}>
            {w.description || "暂无描述"}
          </span>
          <div className="row" style={{ gap: "0.35rem", flexWrap: "wrap" }}>
            <Link
              className="button secondary"
              href={`/worlds/${w.id}/versions`}
              style={{ fontSize: "0.88rem", padding: "0.35rem 0.65rem" }}
            >
              版本
            </Link>
            <Link
              className="button"
              href={`/worlds/${w.id}/workshop`}
              style={{ fontSize: "0.88rem", padding: "0.35rem 0.65rem" }}
            >
              编剧工坊
            </Link>
            <button
              type="button"
              className="button"
              style={{
                fontSize: "0.88rem",
                padding: "0.35rem 0.65rem",
                color: "var(--danger)",
                borderColor: "rgba(248,113,113,0.35)",
              }}
              disabled={deletingId === w.id}
              onClick={() => void handleDelete(w)}
            >
              {deletingId === w.id ? "删除中…" : "删除"}
            </button>
          </div>
        </li>
      ))}
    </ul>
  );
}
