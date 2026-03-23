import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { countWorldsForUser, listWorldsForUser } from "@/lib/db";
import NewWorldLauncher from "./new-world-launcher";
import WorldsList from "./worlds-list";

export default async function WorldsPage() {
  const cookieStore = await cookies();
  const userId = cookieStore.get("cw_user_id")?.value;
  if (!userId) {
    redirect("/sign-in");
  }

  const pageSize = 30;
  const total = countWorldsForUser(userId, {});
  const worlds = listWorldsForUser(userId, { limit: pageSize, offset: 0 });

  return (
    <main className="page-shell">
      <div className="panel">
        <h1 style={{ marginTop: 0 }}>世界书</h1>
        <p className="muted">
          管理世界观与版本；可<strong>新建世界</strong>与编剧对话从零共创，或<strong>导入</strong>已有设定；进<strong>编剧工坊</strong>多轮深化。删除世界将同时移除所有版本与编剧对话，并解除酒馆绑定。
        </p>
        <div className="row" style={{ flexWrap: "wrap", gap: "0.75rem", alignItems: "center" }}>
          <Link className="button primary" href="/worlds/import">
            导入世界书
          </Link>
          <NewWorldLauncher />
          <Link className="button" href="/tavern">
            返回酒馆
          </Link>
        </div>
        <p className="muted" style={{ marginBottom: 0 }}>
          共 {total} 个世界（本页显示前 {worlds.length} 个）
        </p>
      </div>

      <div className="panel" style={{ marginTop: "1rem" }}>
        <h2 style={{ marginTop: 0 }}>你的世界</h2>
        {worlds.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>
            还没有世界。点击「新建世界」与编剧共创，或「导入世界书」；也可使用 API{" "}
            <code className="code-inline">POST /api/worlds</code> 创建。
          </p>
        ) : (
          <WorldsList
            worlds={worlds.map((w) => ({
              id: w.id,
              name: w.name,
              description: w.description,
            }))}
          />
        )}
      </div>
    </main>
  );
}
