import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import {
  ensureThread,
  getWorldVersionWithWorldForUser,
  listPersonasForUser,
  listTavernCharactersForUser,
} from "@/lib/db";
import { listCharacterBookOptions } from "@/lib/tavern-rp-context";

type Params = { params: Promise<{ threadId: string }> };

/**
 * 酒馆对齐：返回人格列表 + 当前世界版本下的可选角色（character_books）
 */
export async function GET(_request: Request, { params }: Params) {
  const cookieStore = await cookies();
  const userId = cookieStore.get("cw_user_id")?.value;
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const { threadId } = await params;
  const id = threadId?.trim();
  if (!id) {
    return NextResponse.json({ error: "threadId is required." }, { status: 400 });
  }

  try {
    const thread = ensureThread(id, userId);
    const personas = listPersonasForUser(userId, 80);
    const tavernCharacters = listTavernCharactersForUser(userId, 100);
    let characterOptions: ReturnType<typeof listCharacterBookOptions> = [];
    if (thread.world_version_id) {
      const bundle = getWorldVersionWithWorldForUser(
        thread.world_version_id,
        userId
      );
      if (bundle) {
        characterOptions = listCharacterBookOptions(
          bundle.versionRow.canonical_json
        );
      }
    }

    return NextResponse.json({
      personas,
      tavernCharacters,
      characterOptions,
      thread: {
        personaId: thread.persona_id,
        activeCharacterBoundEntityId: thread.active_character_bound_entity_id,
        assistantCharacterId: thread.assistant_character_id,
      },
    });
  } catch {
    return NextResponse.json({ error: "Forbidden thread access." }, { status: 403 });
  }
}
