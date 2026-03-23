import Link from "next/link";
import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import {
  getWorldForUser,
  getWorldVersionWithWorldForUser,
  listWorldVersionsForWorld,
} from "@/lib/db";
import { browseCanonicalJson } from "@/lib/world-canonical-browse";
import WorldVersionPicker from "./world-version-picker";
import SyncTavernCharactersButton from "./sync-tavern-characters-button";

type PageProps = {
  params: Promise<{ worldId: string }>;
  searchParams: Promise<{ version?: string }>;
};

export default async function WorldDetailPage({ params, searchParams }: PageProps) {
  const cookieStore = await cookies();
  const userId = cookieStore.get("cw_user_id")?.value;
  if (!userId) {
    redirect("/sign-in");
  }

  const { worldId } = await params;
  const sp = await searchParams;
  const versionParam = sp.version?.trim() || "";

  const world = getWorldForUser(worldId, userId);
  if (!world) {
    notFound();
  }

  let versions: ReturnType<typeof listWorldVersionsForWorld>;
  try {
    versions = listWorldVersionsForWorld(worldId, userId);
  } catch {
    notFound();
  }
  const latest = versions[0] ?? null;

  let bundle: ReturnType<typeof getWorldVersionWithWorldForUser> = null;
  if (versionParam) {
    bundle = getWorldVersionWithWorldForUser(versionParam, userId);
    if (!bundle || bundle.versionRow.world_id !== worldId) {
      bundle = null;
    }
  }
  if (!bundle && latest) {
    bundle = getWorldVersionWithWorldForUser(latest.id, userId);
  }

  const browse = bundle?.versionRow.canonical_json
    ? browseCanonicalJson(bundle.versionRow.canonical_json)
    : null;

  const selectedVersionId = bundle?.versionRow.id ?? "";

  return (
    <main className="page-shell">
      <div className="panel">
      <div style={{ display: "flex", flexWrap: "wrap", gap: "0.75rem", alignItems: "center" }}>
        <h1 style={{ margin: 0, flex: "1 1 auto" }}>{world.name}</h1>
        <WorldVersionPicker
          worldId={worldId}
          versions={versions.map((v) => ({
            id: v.id,
            version: v.version,
            created_at: v.created_at,
          }))}
          selectedVersionId={selectedVersionId || (latest?.id ?? "")}
        />
      </div>
      {world.description ? (
        <p className="muted" style={{ marginTop: "0.5rem" }}>
          {world.description}
        </p>
      ) : null}

      <div style={{ marginTop: "1rem", display: "flex", flexWrap: "wrap", gap: "0.75rem" }}>
        <Link className="button secondary" href="/worlds">
          返回世界列表
        </Link>
        <Link className="button" href={`/worlds/${worldId}/world-forge`}>
          世界熔炉
        </Link>
        <Link className="button" href={`/worlds/${worldId}/workshop`}>
          编剧工坊
        </Link>
        <Link className="button secondary" href={`/worlds/${worldId}/versions`}>
          管理全部版本
        </Link>
        {bundle ? (
          <SyncTavernCharactersButton
            worldId={worldId}
            worldVersionId={bundle.versionRow.id}
          />
        ) : null}
      </div>
      {bundle ? (
        <p className="muted" style={{ fontSize: "0.85rem", marginTop: "0.65rem", marginBottom: 0 }}>
          保存新世界版本时会<strong>自动</strong>把本版本 <code className="code-inline">character_books</code>{" "}
          中有角色卡的条目同步到酒馆「角色」库；若列表未更新可点「同步角色库」补跑一次（以当前所选版本为准）。
        </p>
      ) : null}

      {!bundle ? (
        <div className="section" style={{ marginTop: "1.25rem" }}>
          <p className="muted">尚无已保存的世界版本。请先在「世界熔炉」中导入或编辑并保存。</p>
          <Link className="button" href={`/worlds/${worldId}/world-forge`} style={{ marginTop: "0.75rem" }}>
            打开世界熔炉
          </Link>
        </div>
      ) : browse && !browse.ok ? (
        <div className="section" style={{ marginTop: "1.25rem" }}>
          <p style={{ color: "var(--danger)" }}>解析 Canonical 失败：{browse.error}</p>
          <p className="muted" style={{ marginTop: "0.5rem" }}>
            可在「版本」页查看原始 JSON，或在熔炉中重新保存。
          </p>
        </div>
      ) : browse && browse.ok ? (
        <>
          <section style={{ marginTop: "1.5rem" }}>
            <h2 style={{ fontSize: "1.05rem", marginBottom: "0.5rem" }}>世界书条目</h2>
            <p className="muted" style={{ fontSize: "0.88rem", marginBottom: "0.5rem" }}>
              工件：{browse.worldBookArtifactName} · 共 {browse.worldBookEntries.length} 条（只读）
            </p>
            <div style={{ overflowX: "auto" }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>标题</th>
                    <th>关键词</th>
                    <th>内容预览</th>
                  </tr>
                </thead>
                <tbody>
                  {browse.worldBookEntries.length === 0 ? (
                    <tr>
                      <td colSpan={4} className="muted">
                        暂无条目
                      </td>
                    </tr>
                  ) : (
                    browse.worldBookEntries.map((e) => (
                      <tr key={e.index}>
                        <td>{e.index + 1}</td>
                        <td>{e.title}</td>
                        <td style={{ maxWidth: "14rem", wordBreak: "break-word" }}>{e.keysPreview}</td>
                        <td style={{ maxWidth: "28rem", wordBreak: "break-word" }}>{e.contentPreview}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </section>

          <section style={{ marginTop: "1.5rem" }}>
            <h2 style={{ fontSize: "1.05rem", marginBottom: "0.5rem" }}>人物书 / 角色卡</h2>
            <p className="muted" style={{ fontSize: "0.88rem", marginBottom: "0.5rem" }}>
              共 {browse.characterBooks.length} 本（只读）
            </p>
            <div style={{ overflowX: "auto" }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>标签</th>
                    <th>绑定实体</th>
                    <th>书名</th>
                    <th>条目数</th>
                    <th>角色卡</th>
                    <th>scenario 预览</th>
                  </tr>
                </thead>
                <tbody>
                  {browse.characterBooks.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="muted">
                        暂无人物书
                      </td>
                    </tr>
                  ) : (
                    browse.characterBooks.map((c) => (
                      <tr key={c.index}>
                        <td>{c.index + 1}</td>
                        <td>{c.label}</td>
                        <td>
                          {c.boundEntityName}
                          <span className="muted" style={{ fontSize: "0.8rem", display: "block" }}>
                            {c.boundEntityId}
                          </span>
                        </td>
                        <td>{c.bookName}</td>
                        <td>{c.entriesCount}</td>
                        <td>{c.hasCharacterCard ? "有" : "—"}</td>
                        <td style={{ maxWidth: "24rem", wordBreak: "break-word" }}>{c.scenarioPreview}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </section>

          <section style={{ marginTop: "1.5rem" }}>
            <h2 style={{ fontSize: "1.05rem", marginBottom: "0.5rem" }}>实体列表</h2>
            <p className="muted" style={{ fontSize: "0.88rem", marginBottom: "0.5rem" }}>
              共 {browse.entities.length} 个（只读）
            </p>
            <div style={{ overflowX: "auto" }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>ID</th>
                    <th>名称</th>
                    <th>类型</th>
                    <th>摘要</th>
                  </tr>
                </thead>
                <tbody>
                  {browse.entities.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="muted">
                        暂无实体
                      </td>
                    </tr>
                  ) : (
                    browse.entities.map((e, i) => (
                      <tr key={e.id}>
                        <td>{i + 1}</td>
                        <td style={{ wordBreak: "break-all" }}>{e.id}</td>
                        <td>{e.name}</td>
                        <td>{e.kind}</td>
                        <td style={{ maxWidth: "28rem", wordBreak: "break-word" }}>{e.summary}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </>
      ) : null}
      </div>
    </main>
  );
}
