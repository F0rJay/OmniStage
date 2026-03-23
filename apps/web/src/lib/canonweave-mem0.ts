import "server-only";

import { MemoryClient } from "mem0ai";
import {
  buildMem0UserId,
  getMem0PlatformApiKey,
  getMem0PlatformHost,
  getMem0SearchLimit,
  isMem0Enabled,
} from "@/lib/mem0-config";

let clientSingleton: MemoryClient | null | undefined;
let clientInitFailed = false;

function normalizeSearchResults(raw: unknown): Array<{ memory: string; score?: number }> {
  const rows: unknown[] = (() => {
    if (raw == null) return [];
    if (Array.isArray(raw)) return raw;
    if (typeof raw === "object" && raw !== null) {
      const r = raw as Record<string, unknown>;
      if (Array.isArray(r.results)) return r.results;
      if (Array.isArray(r.memories)) return r.memories;
    }
    return [];
  })();

  const out: Array<{ memory: string; score?: number }> = [];
  for (const item of rows) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const o = item as Record<string, unknown>;
    let mem = "";
    if (typeof o.memory === "string") mem = o.memory;
    else if (o.data && typeof o.data === "object" && !Array.isArray(o.data)) {
      const d = (o.data as Record<string, unknown>).memory;
      if (typeof d === "string") mem = d;
    }
    mem = mem.trim();
    if (!mem) continue;
    const score = typeof o.score === "number" ? o.score : undefined;
    out.push({ memory: mem, score });
  }
  return out;
}

/**
 * 懒加载 Mem0 Platform 客户端。未开启、缺 Key 或构造失败时返回 null。
 */
export function getCanonweaveMem0Client(): MemoryClient | null {
  if (!isMem0Enabled()) {
    clientSingleton = null;
    return null;
  }
  if (clientInitFailed) return null;
  if (clientSingleton) return clientSingleton;

  const apiKey = getMem0PlatformApiKey();
  if (!apiKey) {
    clientInitFailed = true;
    console.warn(
      "[CanonWeave Mem0] CW_MEM0 已开启但未配置 CW_MEM0_PLATFORM_API_KEY / MEM0_API_KEY / CW_MEM0_API_KEY，已跳过。"
    );
    return null;
  }

  try {
    const host = getMem0PlatformHost();
    clientSingleton = new MemoryClient({
      apiKey,
      ...(host ? { host } : {}),
    });
    return clientSingleton;
  } catch (e) {
    clientInitFailed = true;
    console.warn("[CanonWeave Mem0] MemoryClient 初始化失败:", e);
    return null;
  }
}

export function formatMem0RecallForPrompt(
  results: Array<{ memory?: string; score?: number }>
): string | null {
  if (!results.length) return null;
  const lines = results
    .map((r, i) => {
      const text = typeof r.memory === "string" ? r.memory.trim() : "";
      if (!text) return null;
      const score =
        typeof r.score === "number" ? `（相关度 ${r.score.toFixed(3)}）` : "";
      return `${i + 1}. ${text}${score}`;
    })
    .filter((x): x is string => x !== null);
  if (!lines.length) return null;
  return (
    "【Mem0 长期记忆检索（供叙事参考；须与当前世界设定一致，冲突时以世界书为准）】\n" +
    lines.join("\n")
  );
}

export async function searchMem0ForTurn(input: {
  userId: string;
  threadId: string;
  query: string;
}): Promise<{ block: string | null; rawCount: number; memories: string[] }> {
  const client = getCanonweaveMem0Client();
  if (!client) {
    return { block: null, rawCount: 0, memories: [] };
  }
  const q = input.query.trim();
  if (!q) {
    return { block: null, rawCount: 0, memories: [] };
  }
  const user_id = buildMem0UserId(input.userId, input.threadId);
  const limit = getMem0SearchLimit();
  try {
    const raw = await client.search(q, { user_id, limit });
    const items = normalizeSearchResults(raw);
    const memories = items.map((it) => it.memory).filter(Boolean);
    const block = formatMem0RecallForPrompt(items);
    return { block, rawCount: items.length, memories };
  } catch (e) {
    console.warn("[CanonWeave Mem0] search 失败:", e);
    return { block: null, rawCount: 0, memories: [] };
  }
}

export async function ingestMem0Turn(input: {
  userId: string;
  threadId: string;
  userText: string;
  assistantText: string;
  worldVersionId?: string | null;
}): Promise<{ ok: boolean; error?: string }> {
  const client = getCanonweaveMem0Client();
  if (!client) return { ok: false, error: "mem0_unavailable" };

  const userLine = input.userText.trim();
  const asst = input.assistantText.trim();
  if (!userLine || !asst) return { ok: false, error: "empty_turn" };

  const user_id = buildMem0UserId(input.userId, input.threadId);
  const metadata: Record<string, string> = {
    threadId: input.threadId,
  };
  if (input.worldVersionId) {
    metadata.worldVersionId = input.worldVersionId;
  }

  try {
    await client.add(
      [
        { role: "user", content: userLine },
        { role: "assistant", content: asst },
      ],
      {
        user_id,
        metadata: { ...metadata, source: "canonweave_tavern" },
      }
    );
    return { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn("[CanonWeave Mem0] add 失败:", e);
    return { ok: false, error: msg };
  }
}
