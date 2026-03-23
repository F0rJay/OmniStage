import "server-only";

/** 开启 Mem0（Platform HTTP API，`MemoryClient`）。 */
export function isMem0Enabled(): boolean {
  const v = process.env.CW_MEM0?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/**
 * 记忆命名空间：
 * - `thread`（默认）：每会话独立，适合 TRPG 剧情线
 * - `user`：同一用户跨会话共享
 */
export function getMem0Scope(): "thread" | "user" {
  const raw = process.env.CW_MEM0_SCOPE?.trim().toLowerCase();
  return raw === "user" ? "user" : "thread";
}

export function buildMem0UserId(userId: string, threadId: string): string {
  const scope = getMem0Scope();
  if (scope === "user") {
    return `cw_user:${userId}`;
  }
  return `cw_user:${userId}:thread:${threadId}`;
}

export function getMem0SearchLimit(): number {
  const raw = process.env.CW_MEM0_SEARCH_LIMIT?.trim();
  const n = raw ? parseInt(raw, 10) : 8;
  if (!Number.isFinite(n) || n < 1) return 8;
  if (n > 24) return 24;
  return n;
}

/**
 * Mem0 Platform API Key（`Authorization: Token …`）。
 * 依次读取：`CW_MEM0_PLATFORM_API_KEY` → `MEM0_API_KEY` → `CW_MEM0_API_KEY`。
 */
export function getMem0PlatformApiKey(): string | undefined {
  const a = process.env.CW_MEM0_PLATFORM_API_KEY?.trim();
  if (a) return a;
  const b = process.env.MEM0_API_KEY?.trim();
  if (b) return b;
  const c = process.env.CW_MEM0_API_KEY?.trim();
  if (c) return c;
  return undefined;
}

/**
 * API 根地址，默认由 SDK 使用 `https://api.mem0.ai`。
 * 自托管 [Mem0 REST](https://docs.mem0.ai/open-source/features/rest-api) 时设为你的服务根 URL（无尾斜杠）。
 */
export function getMem0PlatformHost(): string | undefined {
  const h = process.env.CW_MEM0_PLATFORM_HOST?.trim();
  if (!h) return undefined;
  return h.replace(/\/+$/, "");
}
