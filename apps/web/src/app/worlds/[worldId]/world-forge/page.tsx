import Link from "next/link";
import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { getLatestWorldVersion, getWorldForUser } from "@/lib/db";
import WorldForgeWorkflowPanel from "./workflow-panel";

type PageProps = { params: Promise<{ worldId: string }> };

export default async function WorldForgePage({ params }: PageProps) {
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

  const latestVersion = getLatestWorldVersion(worldId, userId);
  const hasSavedVersion = latestVersion != null;

  return (
    <main className="page-shell">
      <div className="panel">
        <h1 style={{ marginTop: 0, marginBottom: "0.35rem" }}>世界共创 · {world.name}</h1>
        <p className="muted" style={{ marginTop: 0 }}>
          写下你想补充或修改的设定，AI 会自动完成扩写、角色补充与一致性检查，
          并生成新的世界版本。你可以多轮迭代，逐步把世界打磨完整。
        </p>
        <div className="row" style={{ gap: "0.55rem", flexWrap: "wrap" }}>
          <Link className="button secondary" href="/worlds">
            世界列表
          </Link>
          <Link className="button secondary" href={`/worlds/${worldId}/workshop`}>
            编剧工坊
          </Link>
          <Link className="button secondary" href={`/worlds/${worldId}/versions`}>
            版本
          </Link>
        </div>
      </div>
      <WorldForgeWorkflowPanel
        worldId={worldId}
        worldName={world.name}
        hasSavedVersion={hasSavedVersion}
      />
    </main>
  );
}
