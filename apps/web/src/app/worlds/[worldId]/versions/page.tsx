import Link from "next/link";
import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { getWorldForUser, listWorldVersionsForWorld } from "@/lib/db";
import RestoreVersionButton from "./restore-version-button";

type Props = {
  params: Promise<{ worldId: string }>;
};

export default async function WorldVersionsPage({ params }: Props) {
  const { worldId } = await params;
  const cookieStore = await cookies();
  const userId = cookieStore.get("cw_user_id")?.value;
  if (!userId) {
    redirect("/sign-in");
  }

  const world = getWorldForUser(worldId, userId);
  if (!world) {
    notFound();
  }

  let versions;
  try {
    versions = listWorldVersionsForWorld(worldId, userId);
  } catch {
    notFound();
  }

  return (
    <main className="page-shell">
      <div className="panel">
        <h1 style={{ marginTop: 0 }}>{world.name}</h1>
        <p className="muted">{world.description || "暂无描述。"}</p>
        <div className="row">
          <Link className="button primary" href={`/worlds/${worldId}/workshop`}>
            编剧工坊
          </Link>
          <Link className="button" href="/worlds">
            全部世界
          </Link>
          <Link className="button" href={`/api/worlds/${worldId}`} prefetch={false}>
            API：世界 JSON
          </Link>
        </div>
      </div>

      <div className="panel" style={{ marginTop: "1rem" }}>
        <h2 style={{ marginTop: 0 }}>版本历史</h2>
        <p className="muted" style={{ marginTop: 0 }}>
          导入会保存原始 JSON 快照；「恢复」会把该版本的 Canonical
          <strong>复制为新版本号</strong>，不删除任何历史记录。
        </p>
        {versions.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>
            尚无版本。可通过{" "}
            <Link href="/worlds/import">导入</Link> 或{" "}
            <code className="code-inline">POST /api/worlds/&#123;id&#125;/versions</code>{" "}
            追加。
          </p>
        ) : (
          <ul style={{ margin: 0, paddingLeft: "1.1rem" }}>
            {versions.map((v) => (
              <li key={v.id} style={{ marginBottom: "0.75rem" }}>
                <strong>v{v.version}</strong>
                <span className="muted"> — {v.created_at}</span>
                {v.source_raw_json ? (
                  <span className="muted" style={{ marginLeft: "0.5rem" }}>
                    · 含导入原文快照
                  </span>
                ) : null}
                {v.restored_from_version_id ? (
                  <span className="muted" style={{ marginLeft: "0.5rem" }}>
                    · 自历史版本恢复线
                  </span>
                ) : null}
                <RestoreVersionButton
                  worldId={worldId}
                  fromVersionId={v.id}
                  fromVersionNumber={v.version}
                />
                <pre
                  style={{
                    marginTop: "0.35rem",
                    padding: "0.65rem 0.85rem",
                    background: "var(--bg-deep)",
                    border: "1px solid var(--border)",
                    borderRadius: "var(--radius-sm)",
                    fontSize: "0.8rem",
                    overflowX: "auto",
                    maxHeight: 160,
                    fontFamily: "var(--font-mono)",
                  }}
                >
                  {v.canonical_json.slice(0, 2000)}
                  {v.canonical_json.length > 2000 ? "\n…" : ""}
                </pre>
              </li>
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}
