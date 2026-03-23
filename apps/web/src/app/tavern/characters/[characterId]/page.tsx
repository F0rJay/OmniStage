import Link from "next/link";
import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { getTavernCharacterForUser } from "@/lib/db";
import CharacterEditorForm from "../character-editor-form";

type Props = { params: Promise<{ characterId: string }> };

export default async function EditTavernCharacterPage({ params }: Props) {
  const { characterId } = await params;
  const id = characterId?.trim();
  if (!id) {
    notFound();
  }

  const cookieStore = await cookies();
  const userId = cookieStore.get("cw_user_id")?.value;
  if (!userId) {
    redirect("/sign-in");
  }

  const character = getTavernCharacterForUser(id, userId);
  if (!character) {
    notFound();
  }

  return (
    <main className="page-shell">
      <div className="panel">
        <Link className="button" href="/tavern/characters" style={{ marginBottom: "0.75rem", display: "inline-block" }}>
          ← 返回列表
        </Link>
        <h1 style={{ marginTop: 0 }}>编辑角色</h1>
        <p className="muted" style={{ wordBreak: "break-all", marginBottom: 0 }}>
          {character.id}
        </p>
      </div>
      <CharacterEditorForm
        mode="edit"
        characterId={character.id}
        initialName={character.name}
        initialTags={character.tags}
        initialCardJson={character.character_card_json}
      />
    </main>
  );
}
