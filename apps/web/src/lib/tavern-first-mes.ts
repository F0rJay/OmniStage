import { randomUUID } from "node:crypto";
import {
  ensureThread,
  getTavernCharacterForUser,
  insertMessage,
  listMessagesByThread,
} from "@/lib/db";
import { formatAssistantMessageForPersistence } from "@/lib/chat-speaker";
import { extractFirstMesFromCharacterCardJson } from "@/lib/tavern-character-form";

export type SeedFirstMesResult = {
  inserted: boolean;
  /** 插入成功时的正文 */
  content?: string;
  /** 未插入时的原因（便于调试/日志） */
  skipReason?:
    | "not_empty"
    | "no_assistant_character"
    | "character_not_found"
    | "no_first_mes";
};

/**
 * 空会话且已绑定 AI 酒馆角色时，将角色卡中的 first_mes 写入一条 assistant 消息（对齐 ST 新开聊天）。
 */
export function tryInsertAssistantFirstMesForEmptyThread(
  threadId: string,
  userId: string
): SeedFirstMesResult {
  const thread = ensureThread(threadId, userId);
  const anyMessage = listMessagesByThread(threadId, 1);
  if (anyMessage.length > 0) {
    return { inserted: false, skipReason: "not_empty" };
  }

  const aid = thread.assistant_character_id?.trim();
  if (!aid) {
    return { inserted: false, skipReason: "no_assistant_character" };
  }

  const ch = getTavernCharacterForUser(aid, userId);
  if (!ch) {
    return { inserted: false, skipReason: "character_not_found" };
  }

  const firstMes = extractFirstMesFromCharacterCardJson(ch.character_card_json);
  if (!firstMes) {
    return { inserted: false, skipReason: "no_first_mes" };
  }

  const fin = formatAssistantMessageForPersistence(firstMes);
  insertMessage({
    id: randomUUID(),
    threadId,
    role: "assistant",
    content: fin.content,
    speakerLabel: fin.speakerLabel,
  });

  return { inserted: true, content: fin.content };
}
