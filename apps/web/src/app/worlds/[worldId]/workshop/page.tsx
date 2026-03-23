import Link from "next/link";
import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { getLatestWorldVersion, getWorldForUser } from "@/lib/db";
import ScreenwriterPanel from "./screenwriter-panel";

type PageProps = {
  params: Promise<{ worldId: string }>;
  searchParams: Promise<{ new?: string }>;
};

export default async function WorldWorkshopPage({ params, searchParams }: PageProps) {
  const { worldId } = await params;
  const sp = await searchParams;
  const creationFlow =
    sp.new === "1" || sp.new === "true" || sp.new === "";
  const cookieStore = await cookies();
  const userId = cookieStore.get("cw_user_id")?.value;
  if (!userId) {
    redirect("/sign-in");
  }

  const world = getWorldForUser(worldId, userId);
  if (!world) {
    notFound();
  }

  const latest = getLatestWorldVersion(worldId, userId);
  const initialHasSavedVersion = latest !== null;

  return (
    <main className="page-shell">
      <div className="panel">
        <h1 style={{ marginTop: 0 }}>编剧工坊 · {world.name}</h1>
        <p className="muted">
          与<strong>编剧 Agent</strong>多轮对话修改设定；对话会保存。满意后点击「
          <strong>将对话合并为新版本</strong>」把变更写入 Canonical 新版本。也可继续用
          <Link href="/worlds/import"> 导入世界书 </Link>覆盖或补充。
        </p>
        <div className="row">
          <Link className="button" href="/worlds">
            返回世界列表
          </Link>
          <Link className="button" href={`/worlds/${worldId}/versions`}>
            查看版本
          </Link>
          <Link className="button" href={`/worlds/${worldId}/world-forge`}>
            WorldForge（多 Agent 单轮协作）
          </Link>
        </div>
      </div>
      <ScreenwriterPanel
        worldId={worldId}
        worldName={world.name}
        creationFlow={creationFlow}
        initialHasSavedVersion={initialHasSavedVersion}
      />
    </main>
  );
}
