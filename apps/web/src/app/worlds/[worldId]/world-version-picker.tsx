"use client";

import { useRouter } from "next/navigation";

export default function WorldVersionPicker({
  worldId,
  versions,
  selectedVersionId,
}: {
  worldId: string;
  versions: Array<{ id: string; version: number; created_at: string }>;
  /** 当前展示的 world_versions.id；与「列表首项」相同时可传该 id，下拉仍正确 */
  selectedVersionId: string;
}) {
  const router = useRouter();

  if (versions.length === 0) {
    return null;
  }

  return (
    <label style={{ display: "inline-flex", alignItems: "center", gap: "0.5rem" }}>
      <span className="muted" style={{ fontSize: "0.88rem" }}>
        查看版本
      </span>
      <select
        className="input"
        style={{ width: "auto", minWidth: "12rem" }}
        value={selectedVersionId}
        onChange={(e) => {
          const next = e.target.value;
          router.push(
            next
              ? `/worlds/${worldId}?version=${encodeURIComponent(next)}`
              : `/worlds/${worldId}`
          );
        }}
      >
        {versions.map((v) => (
          <option key={v.id} value={v.id}>
            v{v.version} · {v.created_at.slice(0, 19).replace("T", " ")}
          </option>
        ))}
      </select>
    </label>
  );
}
