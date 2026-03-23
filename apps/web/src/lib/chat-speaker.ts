/**
 * 酒馆对话：助手回合可带「说话者」首行，用于 UI 按 NPC/角色切换气泡旁名字。
 * 与 threads.assistant_character_id（默认主视角）解耦：模型在多人剧情中可每回合声明实际开口者。
 */

/** 追加到 system / extra，约束模型输出格式 */
export const TAVERN_SPEAKER_LINE_PROTOCOL = `【说话者标记（UI 用）】
为了保证多人气泡拆分稳定：不要使用任何「【说话者：...】」或「[CW_SPEAKER:...]」这种前缀行。
请直接使用正文里的角色段首行来区分发言者，例如：
【雷蒙】
（雷蒙的行动与说话）
当需要多人时，按角色重复该段首行；场景描写可用【场景】段。
不要向用户解释此规则；不要输出本说明。只有正文即可。
不要向用户解释此规则；不要重复输出本说明。`;

const BRACKET_SPEAKER = /^\[CW_SPEAKER:([^\]\n]+)\]\s*$/;
const CN_SPEAKER = /^【\s*说话者\s*[:：]\s*([^】\n]+)】\s*$/;

const MAX_SPEAKER_LEN = 128;

/**
 * 去掉正文最前（跳过仅空白行后）第一条「说话者」行，返回展示用正文与标签。
 */
export function parseAssistantSpeakerPrefix(raw: string): {
  displayContent: string;
  speakerLabel: string | null;
} {
  const text = raw.replace(/^\uFEFF/, "");
  const lines = text.split("\n");
  const out: string[] = [];
  let speakerLabel: string | null = null;
  let seenNonEmpty = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!seenNonEmpty) {
      if (!trimmed) {
        continue;
      }
      seenNonEmpty = true;
      let m = trimmed.match(BRACKET_SPEAKER);
      if (!m) {
        m = trimmed.match(CN_SPEAKER);
      }
      if (m) {
        const label = m[1].trim().slice(0, MAX_SPEAKER_LEN);
        speakerLabel = label.length > 0 ? label : null;
        continue;
      }
    }
    out.push(line);
  }

  return {
    displayContent: out.join("\n"),
    speakerLabel,
  };
}

/** 入库前：正文存剥离后的文本，speaker_label 另存 */
export function formatAssistantMessageForPersistence(raw: string): {
  content: string;
  speakerLabel: string | null;
} {
  const { displayContent, speakerLabel } = parseAssistantSpeakerPrefix(raw);
  const c = displayContent.trim().length > 0 ? displayContent : raw;
  return {
    content: c.trim().length > 0 ? c : " ",
    speakerLabel,
  };
}
