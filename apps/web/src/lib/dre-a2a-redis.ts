import "server-only";

import type { DreA2aMessage } from "@/lib/dre-a2a-bus";
import { getDreA2aRedisUrl } from "@/lib/dynamic-rp-config";

type RedisClient = import("redis").RedisClientType;

let client: RedisClient | null = null;
let connectPromise: Promise<RedisClient | null> | null = null;

async function getClient(): Promise<RedisClient | null> {
  const url = getDreA2aRedisUrl();
  if (!url) return null;
  if (client?.isOpen) return client;
  if (connectPromise) return connectPromise;

  connectPromise = (async () => {
    try {
      const { createClient } = await import("redis");
      const c = createClient({ url });
      c.on("error", (err: Error) => {
        console.error("[dre-a2a-redis]", err.message);
      });
      await c.connect();
      client = c as RedisClient;
      return client;
    } catch (e) {
      console.error("[dre-a2a-redis] connect failed", e);
      return null;
    } finally {
      connectPromise = null;
    }
  })();

  return connectPromise;
}

/** 将单条消息追加到本拍列表（调试用 / 多实例观测）。 */
export async function mirrorAppendDreA2a(
  threadId: string,
  beatId: string,
  msg: DreA2aMessage
): Promise<void> {
  const c = await getClient();
  if (!c) return;
  const key = `cw:dre:a2a:beat:${threadId}:${beatId}`;
  await c.rPush(key, JSON.stringify(msg));
  await c.expire(key, 86_400);
}

/** 上一拍结束后写入，供下一拍动作线衔接（短文本）。 */
export async function persistDreA2aThreadContext(
  threadId: string,
  transcript: string
): Promise<void> {
  const c = await getClient();
  if (!c) return;
  const key = `cw:dre:a2a:ctx:${threadId}`;
  const body = transcript.length > 12_000 ? `${transcript.slice(0, 12_000)}…` : transcript;
  await c.set(key, body, { EX: 172_800 });
}

export async function loadDreA2aThreadContext(
  threadId: string
): Promise<string | null> {
  const c = await getClient();
  if (!c) return null;
  const key = `cw:dre:a2a:ctx:${threadId}`;
  const v = await c.get(key);
  return typeof v === "string" && v.length > 0 ? v : null;
}
