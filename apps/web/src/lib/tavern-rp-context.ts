/**
 * 酒馆对话注入：对齐 SillyTavern 心智 — 世界 → AI「角色」→ 世界书中扮演条目 → 玩家人格（Persona）。
 * 纯函数，无 IO。
 * @see https://sillytavern.wiki/usage/characters/
 */

export type PersonaForPrompt = {
  name: string;
  description: string;
  title?: string | null;
};

export type CharacterBookOption = {
  bound_entity_id: string;
  label: string;
};

const MAX_CHARACTER_CARD_PROMPT_CHARS = 12_000;

function mergeBlocks(parts: Array<string | null | undefined>): string | null {
  const xs = parts.map((p) => p?.trim()).filter((s): s is string => Boolean(s));
  if (xs.length === 0) return null;
  return xs.join("\n\n---\n\n");
}

/** 列出可选扮演角色（来自 Canonical character_books） */
export function listCharacterBookOptions(canonicalJson: string): CharacterBookOption[] {
  try {
    const o = JSON.parse(canonicalJson) as Record<string, unknown>;
    const books = o.character_books;
    if (!Array.isArray(books)) return [];
    const out: CharacterBookOption[] = [];
    for (const b of books) {
      if (!b || typeof b !== "object" || Array.isArray(b)) continue;
      const r = b as Record<string, unknown>;
      const idRaw = typeof r.bound_entity_id === "string" ? r.bound_entity_id.trim() : "";
      const name = typeof r.bound_entity_name === "string" ? r.bound_entity_name.trim() : "";
      const bookName = typeof r.name === "string" ? r.name.trim() : "";
      const key = idRaw || name || bookName;
      if (!key) continue;
      out.push({
        bound_entity_id: idRaw || key,
        label: name || bookName || key,
      });
    }
    return out;
  } catch {
    return [];
  }
}

function matchesCharacterBook(
  book: Record<string, unknown>,
  needle: string
): boolean {
  const id = typeof book.bound_entity_id === "string" ? book.bound_entity_id.trim() : "";
  const nm = typeof book.bound_entity_name === "string" ? book.bound_entity_name.trim() : "";
  const bn = typeof book.name === "string" ? book.name.trim() : "";
  return id === needle || nm === needle || bn === needle;
}

/** 将单份 character_card 对象格式化为提示块（共用：世界书条目 / 用户酒馆角色库） */
export function formatCharacterCardObjectForPrompt(input: {
  headingLine: string;
  roleHint: string;
  card: Record<string, unknown>;
}): string {
  const lines: string[] = [input.headingLine, input.roleHint];
  const orderedKeys = [
    "description",
    "personality",
    "scenario",
    "appearance",
    "backstory",
    "relationships",
    "speech_patterns",
    "first_mes",
    "mes_example",
    "post_history_instructions",
    "creator_notes",
  ] as const;
  for (const k of orderedKeys) {
    const v = input.card[k];
    if (typeof v === "string" && v.trim()) {
      lines.push(`### ${k}\n${v.trim()}`);
    }
  }
  if (Array.isArray(input.card.alternate_greetings)) {
    const gs = input.card.alternate_greetings
      .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
      .map((x) => `- ${x.trim()}`);
    if (gs.length > 0) {
      lines.push(`### alternate_greetings\n${gs.join("\n")}`);
    }
  }
  if (Array.isArray(input.card.tags)) {
    const ts = input.card.tags.filter(
      (x): x is string => typeof x === "string" && x.trim().length > 0
    );
    if (ts.length > 0) {
      lines.push(`### tags\n${ts.join(", ")}`);
    }
  }
  let body = lines.join("\n\n");
  if (body.length > MAX_CHARACTER_CARD_PROMPT_CHARS) {
    body =
      body.slice(0, MAX_CHARACTER_CARD_PROMPT_CHARS) +
      "\n…[角色卡上下文已截断]";
  }
  return body;
}

/** 用户库中的 AI 酒馆角色（SillyTavern「角色」面板）→ 系统提示块 */
export function formatAssistantTavernCharacterForPrompt(input: {
  name: string;
  characterCardJson: string;
}): string | null {
  const displayName = input.name.trim() || "未命名角色";
  try {
    const parsed = JSON.parse(input.characterCardJson) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return (
        `【酒馆角色（AI 扮演）】${displayName}\n` +
        "（角色卡 JSON 为空或非对象；请在「角色」页补全描述、个性、场景等字段。）"
      );
    }
    return formatCharacterCardObjectForPrompt({
      headingLine: `【酒馆角色（AI 扮演，对齐 SillyTavern「角色」）】${displayName}`,
      roleHint:
        "以下字段定义模型在本聊天中应扮演的 AI 角色（语气、背景、示例对话等）。用户侧表达见「人格」；若绑定世界书中扮演条目，则为玩家在设定内的身份，勿与 AI 角色混淆。",
      card: parsed as Record<string, unknown>,
    });
  } catch {
    return null;
  }
}

/** 将当前选中人物书的 character_card 格式化为系统提示块 */
export function formatCharacterCardContextForPrompt(
  canonicalJson: string,
  boundEntityId: string
): string | null {
  const needle = boundEntityId.trim();
  if (!needle) return null;
  try {
    const o = JSON.parse(canonicalJson) as Record<string, unknown>;
    const books = o.character_books;
    if (!Array.isArray(books)) return null;
    for (const b of books) {
      if (!b || typeof b !== "object" || Array.isArray(b)) continue;
      const r = b as Record<string, unknown>;
      if (!matchesCharacterBook(r, needle)) continue;

      const bname =
        (typeof r.bound_entity_name === "string" && r.bound_entity_name.trim()) ||
        (typeof r.bound_entity_id === "string" && r.bound_entity_id.trim()) ||
        needle;
      const card = r.character_card;
      if (!card || typeof card !== "object" || Array.isArray(card)) {
        return (
          `【当前扮演角色】${bname}\n` +
          `（该人物书条目存在但未包含 character_card；请在 WorldForge/导入中补全 SillyTavern 式角色卡字段。）`
        );
      }
      return formatCharacterCardObjectForPrompt({
        headingLine: `【世界书中扮演角色（character_books）】${bname}`,
        roleHint:
          "以下字段供叙事遵守玩家在设定内的身份；用户自然语言消息仍以「玩家人格」为准，勿混淆。",
        card: card as Record<string, unknown>,
      });
    }
    return `【当前扮演角色】${needle}\n（canonical 中未找到 bound_entity_id/name 匹配的人物书。）`;
  } catch {
    return null;
  }
}

/** 玩家人格（对齐 SillyTavern Persona 文档语义，无头像/多模态） */
export function formatPersonaContextForPrompt(p: PersonaForPrompt): string {
  const name = p.name.trim() || "未命名人格";
  const parts = [`【玩家身份（Persona / 人格）】${name}`];
  if (p.title?.trim()) {
    parts.push(`标题：${p.title.trim()}`);
  }
  const desc = (p.description ?? "").trim();
  if (desc) {
    parts.push(`描述：\n${desc}`);
  }
  parts.push(
    "用户发送的消息即此人格所表达；叙事与 NPC 回应须与此身份一致，勿擅自改写用户立场。"
  );
  return parts.join("\n\n");
}

/**
 * 合并顺序：世界块 → AI 酒馆角色 → 世界书中扮演角色卡 → 人格。
 */
export function buildTavernInjectedWorldContext(input: {
  baseWorldBlock: string | null;
  assistantCharacter: {
    name: string;
    characterCardJson: string;
  } | null;
  canonicalJson: string | null;
  activeCharacterBoundEntityId: string | null | undefined;
  persona: PersonaForPrompt | null;
}): string | null {
  const assistant = input.assistantCharacter
    ? formatAssistantTavernCharacterForPrompt({
        name: input.assistantCharacter.name,
        characterCardJson: input.assistantCharacter.characterCardJson,
      })
    : null;
  const char =
    input.canonicalJson && input.activeCharacterBoundEntityId?.trim()
      ? formatCharacterCardContextForPrompt(
          input.canonicalJson,
          input.activeCharacterBoundEntityId.trim()
        )
      : null;
  const per = input.persona ? formatPersonaContextForPrompt(input.persona) : null;
  return mergeBlocks([input.baseWorldBlock, assistant, char, per]);
}
