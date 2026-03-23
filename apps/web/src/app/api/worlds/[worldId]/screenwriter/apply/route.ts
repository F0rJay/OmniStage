import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { parseAndValidateCanonicalWorld } from "@/lib/canonical-world";
import {
  createWorldVersion,
  getLatestWorldVersion,
  getOrCreateScreenwriterSession,
  getUserModelPreference,
  getWorldForUser,
  listScreenwriterMessages,
} from "@/lib/db";
import {
  getApiKeyForProvider,
  isChatMockMode,
  missingKeyMessage,
} from "@/lib/llm";
import { isWorldImportAgentDisabled } from "@/lib/mcp-config";
import { mergeCanonicalFromScreenwriterDialogue } from "@/lib/screenwriter-merge-agent";

export const runtime = "nodejs";
export const maxDuration = 120;

type Params = { params: Promise<{ worldId: string }> };

function formatTranscript(
  messages: Array<{ role: "user" | "assistant"; content: string }>
): string {
  return messages
    .map((m) =>
      m.role === "user"
        ? `【用户】\n${m.content}`
        : `【编剧】\n${m.content}`
    )
    .join("\n\n---\n\n");
}

export async function POST(_request: Request, { params }: Params) {
  const cookieStore = await cookies();
  const userId = cookieStore.get("cw_user_id")?.value;
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const { worldId } = await params;
  const world = getWorldForUser(worldId, userId);
  if (!world) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  if (isWorldImportAgentDisabled()) {
    return NextResponse.json(
      {
        error:
          "服务端已关闭基于模型的世界书写入（CW_WORLD_IMPORT_AGENT=0）。无法从对话落库。",
      },
      { status: 403 }
    );
  }

  const sessionId = getOrCreateScreenwriterSession(worldId, userId);
  const messages = listScreenwriterMessages(sessionId, userId);
  if (messages.length === 0) {
    return NextResponse.json(
      { error: "暂无对话记录；请先与编剧说明要修改的设定。" },
      { status: 400 }
    );
  }

  const pref = getUserModelPreference(userId);
  const useMock = isChatMockMode();

  if (!useMock && !getApiKeyForProvider(pref.provider)) {
    return NextResponse.json(
      { error: missingKeyMessage(pref.provider) },
      { status: 503 }
    );
  }

  const latest = getLatestWorldVersion(worldId, userId);
  const currentJson = latest?.canonical_json ?? null;
  const transcript = formatTranscript(messages);

  let normalizedJson: string;

  if (useMock) {
    const mockCanonical = {
      meta: {
        title: world.name,
        note: "Mock：未调用模型；请在关闭 CW_CHAT_MOCK 后重新落库以获得真实合并。",
      },
      entities: [] as unknown[],
      relations: [] as unknown[],
      rules: [] as unknown[],
      timeline: [] as unknown[],
      lore_entries: [] as unknown[],
      locks: [] as unknown[],
      warnings: [] as unknown[],
    };
    if (currentJson) {
      const parsed = parseAndValidateCanonicalWorld(currentJson);
      if (parsed.ok) {
        mockCanonical.meta = {
          ...parsed.canonical.meta,
          ...mockCanonical.meta,
        };
        mockCanonical.entities = parsed.canonical.entities;
        mockCanonical.relations = parsed.canonical.relations;
        mockCanonical.rules = parsed.canonical.rules;
        mockCanonical.timeline = parsed.canonical.timeline;
        mockCanonical.lore_entries = parsed.canonical.lore_entries;
        mockCanonical.locks = parsed.canonical.locks;
        mockCanonical.warnings = parsed.canonical.warnings;
      }
    }
    const v = parseAndValidateCanonicalWorld(JSON.stringify(mockCanonical));
    if (!v.ok) {
      return NextResponse.json(
        { error: "Mock 合并校验失败。", errors: v.errors },
        { status: 500 }
      );
    }
    normalizedJson = v.normalizedJson;
  } else {
    const merged = await mergeCanonicalFromScreenwriterDialogue({
      worldName: world.name,
      currentCanonicalJson: currentJson,
      dialogueTranscript: transcript,
      provider: pref.provider,
      modelId: pref.modelId,
    });

    if (!merged.ok) {
      return NextResponse.json(
        { error: merged.error, errors: merged.errors },
        { status: 422 }
      );
    }
    normalizedJson = merged.validated.normalizedJson;
  }

  try {
    const version = createWorldVersion(worldId, userId, {
      canonicalJson: normalizedJson,
      sourceRawJson: JSON.stringify({
        kind: "screenwriter_merge",
        worldId,
        sessionId,
        messageCount: messages.length,
        mock: useMock,
        at: new Date().toISOString(),
      }),
    });

    return NextResponse.json({
      ok: true,
      version,
      versionsUrl: `/worlds/${worldId}/versions`,
      mock: useMock,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "保存版本失败。";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
