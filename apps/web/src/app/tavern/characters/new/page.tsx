import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import CharacterEditorForm from "../character-editor-form";

export default async function NewTavernCharacterPage() {
  const cookieStore = await cookies();
  if (!cookieStore.get("cw_user_id")?.value) {
    redirect("/sign-in");
  }

  return (
    <main className="page-shell">
      <div className="panel">
        <Link className="button" href="/tavern/characters" style={{ marginBottom: "0.75rem", display: "inline-block" }}>
          ← 返回列表
        </Link>
        <h1 style={{ marginTop: 0 }}>创建新角色</h1>
      </div>
      <CharacterEditorForm mode="create" />
    </main>
  );
}
