import Link from "next/link";
import { cookies } from "next/headers";
import {
  countThreadsForUser,
  findUserDisplayName,
  getLatestThreadForUser,
  listThreadsForUser,
} from "@/lib/db";
import { MODEL_OPTIONS } from "@/lib/models";
import SessionListPanel from "./session-list-panel";

function getDisplayNameFromSession(raw: string | undefined): string {
  if (!raw) return "旅人";
  const [name] = raw.split("|");
  return name?.trim() || "旅人";
}

export default async function TavernPage() {
  const cookieStore = await cookies();
  const session = cookieStore.get("cw_session")?.value;
  const userId = cookieStore.get("cw_user_id")?.value;
  const displayNameFromDb = userId ? findUserDisplayName(userId) : null;
  const latestThread = userId ? getLatestThreadForUser(userId) : null;
  const pageSize = 10;
  const recentThreads = userId
    ? listThreadsForUser(userId, { limit: pageSize, offset: 0 })
    : [];
  const recentTotal = userId ? countThreadsForUser(userId, {}) : 0;
  const displayName = displayNameFromDb ?? getDisplayNameFromSession(session);

  return (
    <main className="page-shell">
      <div className="panel">
        <h1 style={{ marginTop: 0 }}>欢迎回来，{displayName}</h1>
        <p className="muted">
          这里是你的单人酒馆：新建或继续会话，与 AI
          进行流式角色扮演；可在「世界书」导入设定并绑定到会话。
        </p>
      </div>

      <div className="panel" style={{ marginTop: "1rem" }}>
        <h2 style={{ marginTop: 0 }}>快捷操作</h2>
        <div className="row">
          <form method="post" action="/api/threads/create">
            <button className="button primary" type="submit">
              新开一局
            </button>
          </form>
          {latestThread ? (
            <Link className="button" href={`/tavern/sessions/${latestThread.id}`}>
              继续上次会话
            </Link>
          ) : null}
          <Link className="button" href="/tavern/characters">
            角色
          </Link>
          <Link className="button" href="/worlds">
            世界书
          </Link>
          <Link className="button" href="/profile">
            模型偏好
          </Link>
          <form method="post" action="/api/auth/logout">
            <button className="button" type="submit">
              退出登录
            </button>
          </form>
        </div>
      </div>

      <SessionListPanel
        initialThreads={recentThreads}
        initialTotal={recentTotal}
        pageSize={pageSize}
        modelOptions={MODEL_OPTIONS}
      />
    </main>
  );
}
