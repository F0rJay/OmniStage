import "server-only";

/** 单条 NPC 后台总线消息（多轮 A2A）。 */
export type DreA2aMessage = {
  round: number;
  from: string;
  text: string;
  at: string;
};

export function formatA2aTranscript(messages: DreA2aMessage[]): string {
  return messages
    .map((m) => `[R${m.round}] ${m.from}：${m.text}`)
    .join("\n");
}
