/**
 * SillyTavern 式「角色」表单 ↔ character_card_json（扁平字段，不含头像）
 * @see https://sillytavern.wiki/usage/characters/
 */

export type TavernCharacterCardForm = {
  description: string;
  personality: string;
  scenario: string;
  first_mes: string;
  mes_example: string;
  appearance: string;
  backstory: string;
  relationships: string;
  speech_patterns: string;
  post_history_instructions: string;
  creator_notes: string;
  /** 每行一条替代问候 */
  alternateGreetingsLines: string;
};

export const EMPTY_TAVERN_CHARACTER_CARD_FORM: TavernCharacterCardForm = {
  description: "",
  personality: "",
  scenario: "",
  first_mes: "",
  mes_example: "",
  appearance: "",
  backstory: "",
  relationships: "",
  speech_patterns: "",
  post_history_instructions: "",
  creator_notes: "",
  alternateGreetingsLines: "",
};

export function formToCharacterCardJson(form: TavernCharacterCardForm): string {
  const o: Record<string, unknown> = {};
  const put = (key: string, value: string) => {
    const t = value.trim();
    if (t) {
      o[key] = t;
    }
  };
  put("description", form.description);
  put("personality", form.personality);
  put("scenario", form.scenario);
  put("first_mes", form.first_mes);
  put("mes_example", form.mes_example);
  put("appearance", form.appearance);
  put("backstory", form.backstory);
  put("relationships", form.relationships);
  put("speech_patterns", form.speech_patterns);
  put("post_history_instructions", form.post_history_instructions);
  put("creator_notes", form.creator_notes);
  const greetings = form.alternateGreetingsLines
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (greetings.length > 0) {
    o.alternate_greetings = greetings;
  }
  return JSON.stringify(o);
}

/** 从角色卡 JSON 读取 first_mes（SillyTavern 第一条消息 / AI 开场） */
export function extractFirstMesFromCharacterCardJson(json: string): string | null {
  try {
    const raw = JSON.parse(json) as Record<string, unknown>;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return null;
    }
    const v = raw.first_mes;
    if (typeof v !== "string" || !v.trim()) {
      return null;
    }
    return v.trim();
  } catch {
    return null;
  }
}

export function characterCardJsonToForm(json: string): TavernCharacterCardForm {
  const base = { ...EMPTY_TAVERN_CHARACTER_CARD_FORM };
  try {
    const raw = JSON.parse(json) as Record<string, unknown>;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return base;
    }
    const s = (k: string) =>
      typeof raw[k] === "string" ? (raw[k] as string) : "";
    base.description = s("description");
    base.personality = s("personality");
    base.scenario = s("scenario");
    base.first_mes = s("first_mes");
    base.mes_example = s("mes_example");
    base.appearance = s("appearance");
    base.backstory = s("backstory");
    base.relationships = s("relationships");
    base.speech_patterns = s("speech_patterns");
    base.post_history_instructions = s("post_history_instructions");
    base.creator_notes = s("creator_notes");
    if (Array.isArray(raw.alternate_greetings)) {
      base.alternateGreetingsLines = raw.alternate_greetings
        .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
        .join("\n");
    }
  } catch {
    /* ignore */
  }
  return base;
}
