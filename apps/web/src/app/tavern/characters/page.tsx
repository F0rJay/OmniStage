import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { listTavernCharactersForUser } from "@/lib/db";

export default async function TavernCharactersPage() {
  const cookieStore = await cookies();
  const userId = cookieStore.get("cw_user_id")?.value;
  if (!userId) {
    redirect("/sign-in");
  }

  const characters = listTavernCharactersForUser(userId, 100);

  return (
    <main className="page-shell">
      <div className="panel">
        <div
          className="row"
          style={{
            justifyContent: "space-between",
            alignItems: "center",
            flexWrap: "wrap",
            gap: "0.75rem",
          }}
        >
          <h1 style={{ margin: 0 }}>角色</h1>
          <div className="row" style={{ flexWrap: "wrap", gap: "0.5rem" }}>
            <Link className="button primary" href="/tavern/characters/new">
              创建新角色
            </Link>
            <Link className="button" href="/tavern">
              返回酒馆
            </Link>
          </div>
        </div>
        <p className="muted">
          管理 AI 在对话中扮演的身份（对齐{" "}
          <a
            href="https://sillytavern.wiki/usage/characters/"
            target="_blank"
            rel="noreferrer"
          >
            SillyTavern「角色」
          </a>
          ）。与会话绑定后注入系统提示；「人格」仍是玩家侧身份。标记为「世界同步」的条目来自世界书{" "}
          <code className="code-inline">character_books</code>：每次<strong>保存新世界版本</strong>会自动更新；下次保存前你在本页的修改可能被覆盖。
        </p>
      </div>

      <div className="panel" style={{ marginTop: "1rem" }}>
        <h2 style={{ marginTop: 0 }}>角色列表 · {characters.length}</h2>
        {characters.length === 0 ? (
          <p className="muted">暂无角色，点击「创建新角色」开始。</p>
        ) : (
          <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {characters.map((c) => (
              <li
                key={c.id}
                style={{
                  padding: "0.65rem 0",
                  borderBottom: "1px solid rgba(255,255,255,0.08)",
                }}
              >
                <div className="row" style={{ justifyContent: "space-between", gap: "0.5rem" }}>
                  <div>
                    <strong>{c.name}</strong>
                    {c.tags?.trim() ? (
                      <span className="muted" style={{ marginLeft: "0.5rem", fontSize: "0.85rem" }}>
                        {c.tags}
                      </span>
                    ) : null}
                    {c.sync_world_id ? (
                      <span
                        className="muted"
                        style={{ marginLeft: "0.5rem", fontSize: "0.8rem" }}
                        title={`bound_entity: ${c.sync_bound_entity_id ?? "?"}`}
                      >
                        · 世界书同步
                      </span>
                    ) : null}
                    <p className="muted" style={{ fontSize: "0.78rem", margin: "0.25rem 0 0", wordBreak: "break-all" }}>
                      {c.id}
                    </p>
                  </div>
                  <Link className="button" href={`/tavern/characters/${c.id}`}>
                    编辑
                  </Link>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}
