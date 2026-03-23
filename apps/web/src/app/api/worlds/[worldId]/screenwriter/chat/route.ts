import { cookies } from "next/headers";
import {
  getLatestWorldVersion,
  getOrCreateScreenwriterSession,
  getUserModelPreference,
  getWorldForUser,
  insertScreenwriterMessage,
  listScreenwriterMessages,
} from "@/lib/db";
import {
  buildCoreMessages,
  getApiKeyForProvider,
  isChatMockMode,
  missingKeyMessage,
} from "@/lib/llm";
import { streamScreenwriterCompletion } from "@/lib/screenwriter-llm";

export const runtime = "nodejs";
export const maxDuration = 120;

type Params = { params: Promise<{ worldId: string }> };

type StreamEvent =
  | { event: "token"; data: { delta: string } }
  | { event: "done"; data: { sessionId: string } }
  | { event: "error"; data: { message: string } };

function toSse(e: StreamEvent): string {
  return `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`;
}

type Body = { text?: string; scratchCreation?: boolean };

export async function POST(request: Request, { params }: Params) {
  const cookieStore = await cookies();
  const userId = cookieStore.get("cw_user_id")?.value;
  if (!userId) {
    return new Response("Unauthorized", { status: 401 });
  }

  const { worldId } = await params;
  const world = getWorldForUser(worldId, userId);
  if (!world) {
    return new Response("Not found", { status: 404 });
  }

  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  const text = body.text?.trim();
  if (!text) {
    return new Response("text required", { status: 400 });
  }

  const scratchCreation = Boolean(body.scratchCreation);

  const useMock = isChatMockMode();
  const pref = getUserModelPreference(userId);
  if (
    !useMock &&
    !getApiKeyForProvider(pref.provider)
  ) {
    return new Response(missingKeyMessage(pref.provider), { status: 503 });
  }

  const sessionId = getOrCreateScreenwriterSession(worldId, userId);
  insertScreenwriterMessage({
    sessionId,
    userId,
    role: "user",
    content: text,
  });

  const historyRows = listScreenwriterMessages(sessionId, userId);
  const coreMessages = buildCoreMessages(
    historyRows.map((m) => ({ role: m.role, content: m.content }))
  );

  const latest = getLatestWorldVersion(worldId, userId);
  const latestForPrompt = latest
    ? { version: latest.version, canonical_json: latest.canonical_json }
    : null;

  const encoder = new TextEncoder();

  if (useMock) {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const reply =
          `（Mock）已收到你对「${world.name}」的补充：「${text.slice(0, 80)}${text.length > 80 ? "…" : ""}」。\n\n` +
          (scratchCreation && !latestForPrompt
            ? "在真实 Key 下，编剧会引导你从零搭世界；满意后点「将对话合并为新版本」。"
            : "在真实 Key 环境下，编剧会结合当前 Canonical 做多轮深化；可点「将对话合并为新版本」写入。");
        const parts = reply.split(/(?=[。！？\n])/);
        let i = 0;
        const tick = () => {
          if (i < parts.length) {
            controller.enqueue(
              encoder.encode(
                toSse({ event: "token", data: { delta: parts[i] } })
              )
            );
            i += 1;
            setTimeout(tick, 45);
            return;
          }
          insertScreenwriterMessage({
            sessionId,
            userId,
            role: "assistant",
            content: reply,
          });
          controller.enqueue(
            encoder.encode(toSse({ event: "done", data: { sessionId } }))
          );
          controller.close();
        };
        tick();
      },
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      },
    });
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let assistantText = "";
      try {
        const result = streamScreenwriterCompletion({
          provider: pref.provider,
          modelId: pref.modelId,
          messages: coreMessages,
          worldName: world.name,
          latestVersion: latestForPrompt,
          scratchCreation: scratchCreation && !latestForPrompt,
        });

        for await (const delta of result.textStream) {
          assistantText += delta;
          controller.enqueue(
            encoder.encode(toSse({ event: "token", data: { delta } }))
          );
        }

        insertScreenwriterMessage({
          sessionId,
          userId,
          role: "assistant",
          content: assistantText.trim() || " ",
        });

        controller.enqueue(
          encoder.encode(toSse({ event: "done", data: { sessionId } }))
        );
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "模型调用失败，请稍后重试。";
        controller.enqueue(
          encoder.encode(toSse({ event: "error", data: { message } }))
        );
        if (assistantText.trim()) {
          insertScreenwriterMessage({
            sessionId,
            userId,
            role: "assistant",
            content: assistantText,
          });
        }
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
