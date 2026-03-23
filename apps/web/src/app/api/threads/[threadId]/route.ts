import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import {
  ensureThread,
  insertSessionEvent,
  mergeThreadSessionState,
  renameThread,
  setThreadArchived,
  updateThreadRpBinding,
  updateThreadWorldVersion,
  type ThreadRecord,
} from "@/lib/db";
import { parseThreadSessionStateJson } from "@/lib/session-state";

type Params = { params: Promise<{ threadId: string }> };

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
    return NextResponse.json({
      thread: {
        ...thread,
        sessionState: parseThreadSessionStateJson(thread.session_state_json),
      },
    });
  } catch {
    return NextResponse.json({ error: "Forbidden thread access." }, { status: 403 });
  }
}

type PatchRequestBody = {
  title?: string;
  archived?: boolean;
  /** 绑定 world_versions.id；传 null 或空字符串解除绑定 */
  worldVersionId?: string | null;
  /** 浅合并写入 session_state_json，并记一条 state_patched 事件 */
  sessionStatePatch?: Record<string, unknown> | null;
  /** 玩家人格 personas.id；null 或空字符串解绑 */
  personaId?: string | null;
  /** 当前角色：匹配 canonical.character_books；null 或空字符串解绑 */
  activeCharacterBoundEntityId?: string | null;
  /** AI 酒馆角色 tavern_characters.id（SillyTavern「角色」）；null 或空字符串解绑 */
  assistantCharacterId?: string | null;
};

export async function PATCH(request: Request, { params }: Params) {
  const cookieStore = await cookies();
  const userId = cookieStore.get("cw_user_id")?.value;
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  let body: PatchRequestBody;
  try {
    body = (await request.json()) as PatchRequestBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const { threadId } = await params;
  const id = threadId?.trim();
  if (!id) {
    return NextResponse.json({ error: "threadId is required." }, { status: 400 });
  }

  let thread: ThreadRecord | undefined;

  try {
    if (typeof body.archived === "boolean") {
      thread = setThreadArchived(id, userId, body.archived);
    }

    const title = body.title?.trim();
    if (title) {
      thread = renameThread(id, userId, title.slice(0, 80));
    }

    if (body.worldVersionId !== undefined) {
      const wv =
        body.worldVersionId === null || body.worldVersionId === ""
          ? null
          : body.worldVersionId;
      thread = updateThreadWorldVersion(id, userId, wv);
    }

    if (body.sessionStatePatch !== undefined && body.sessionStatePatch !== null) {
      if (
        typeof body.sessionStatePatch !== "object" ||
        Array.isArray(body.sessionStatePatch)
      ) {
        return NextResponse.json(
          { error: "sessionStatePatch must be a JSON object." },
          { status: 400 }
        );
      }
      const { state, keys } = mergeThreadSessionState(
        id,
        userId,
        body.sessionStatePatch
      );
      if (keys.length > 0) {
        insertSessionEvent({
          id: randomUUID(),
          threadId: id,
          userId,
          eventType: "state_patched",
          payload: { keys, state, source: "api_patch" },
        });
      }
      thread = ensureThread(id, userId);
    }

    if (
      body.personaId !== undefined ||
      body.activeCharacterBoundEntityId !== undefined ||
      body.assistantCharacterId !== undefined
    ) {
      thread = updateThreadRpBinding(id, userId, {
        personaId: body.personaId,
        activeCharacterBoundEntityId: body.activeCharacterBoundEntityId,
        assistantCharacterId: body.assistantCharacterId,
      });
    }

    if (!thread) {
      return NextResponse.json(
        {
          error:
            "Provide title, archived, worldVersionId, sessionStatePatch, personaId, activeCharacterBoundEntityId, and/or assistantCharacterId.",
        },
        { status: 400 }
      );
    }

    return NextResponse.json({ ok: true, thread });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Forbidden thread access.";
    if (msg.includes("not found") || msg.includes("inaccessible")) {
      return NextResponse.json({ error: msg }, { status: 400 });
    }
    return NextResponse.json({ error: "Forbidden thread access." }, { status: 403 });
  }
}

export async function DELETE(_request: Request, { params }: Params) {
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
    const thread = setThreadArchived(id, userId, true);
    return NextResponse.json({ ok: true, thread });
  } catch {
    return NextResponse.json({ error: "Forbidden thread access." }, { status: 403 });
  }
}
