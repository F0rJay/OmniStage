/**
 * Minimal Canonical World validation for Step 9 (paste JSON → validate → persist).
 * Aligns with doc: meta, entities, relations, rules, timeline, lore_entries, locks, warnings.
 * Optional lorebook layers: `world_book`（世界范围条目）、`character_books`（绑定人物卡的人物书），见 `docs/world-lorebook-spec.md`。
 */

/** 单条世界书 / 人物书条目（宽松 object，便于 LLM 输出与 ST 风格字段对齐） */
export type LorebookEntryRecord = Record<string, unknown>;

/** SillyTavern 风格世界书本体：国家/文化/组织/历史等，与人物解耦 */
export type WorldLorebookArtifact = Record<string, unknown> & {
  entries: LorebookEntryRecord[];
};

/** 绑定某一角色实体的人物书（可多本） */
export type CharacterLorebookArtifact = Record<string, unknown> & {
  entries: LorebookEntryRecord[];
};

export type CanonicalWorld = {
  meta: Record<string, unknown>;
  entities: unknown[];
  relations: unknown[];
  rules: unknown[];
  timeline: unknown[];
  lore_entries: unknown[];
  locks: unknown[];
  warnings: unknown[];
  /** 可选：世界范围 Lorebook 条目层 */
  world_book?: WorldLorebookArtifact;
  /** 可选：按人物绑定的人物书 */
  character_books?: CharacterLorebookArtifact[];
};

export type ValidateResult =
  | { ok: true; canonical: CanonicalWorld; normalizedJson: string }
  | { ok: false; errors: string[] };

const MAX_RAW_BYTES = 512 * 1024;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 仅作极端超长输入的兜底，避免 JSON 爆体积；正常 greeting 不应触发截断。 */
const MAX_GREETING_ACTION_CHARS = 3500;
const MAX_GREETING_SPEECH_CHARS = 2000;

function shorten(input: string, maxLen: number): string {
  const s = input.trim();
  if (s.length <= maxLen) return s;
  return s.slice(0, Math.max(0, maxLen)).trim();
}

function cleanQuoted(text: string): string {
  return text.replace(/^[\s"'“”‘’「」]+|[\s"'“”‘’「」]+$/g, "").trim();
}

/**
 * 动作描述里去掉句首角色名（与卡面 name 对齐）；不写进（）里的第三人称自称。
 */
function stripLeadingCharName(action: string, charName: string): string {
  let a = action.trim();
  if (!a) return a;
  const n = charName.trim();
  if (n) {
    if (a.startsWith(n)) {
      a = a.slice(n.length).replace(/^[，,、。．.！!？?\s]+/, "").trim();
    } else {
      const firstSeg = n.split(/[·•．.\s]/)[0]?.trim();
      if (
        firstSeg &&
        firstSeg.length > 0 &&
        firstSeg !== n &&
        a.startsWith(firstSeg)
      ) {
        a = a.slice(firstSeg.length).replace(/^[，,、。．.！!？?\s]+/, "").trim();
      }
    }
  }
  a = a.replace(/^\{\{char\}\}\s*/gi, "").trim();
  return a || action.trim();
}

function trimActionTailPunctuation(action: string): string {
  return action.replace(/[。．.！!？?]+$/g, "").trim();
}

/** 若整段被单对 * 包裹，去掉星号叙述标记 */
function unwrapAsteriskNarrative(narrative: string): string {
  const s = narrative.trim();
  const m = s.match(/^\*([^*]+)\*\s*$/);
  return m?.[1]?.trim() ? m[1].trim() : s;
}

function looksLikeSceneLabel(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  const sceneWords =
    /(总部|工作室|办公室|会议室|门口|街头|墓前|雨夜|深夜|清晨|战场|黑市|酒吧|病房|走廊|车站|广场|公寓|入口|天台|厨房|教室)/;
  const actionVerbs =
    /(看|抬|敲|笑|叹|皱|握|靠|点头|摆手|停顿|挑眉|压低|拽|翻|合上|抱臂|侧身|垂眼|望向|盯着|揉|挥手|俯身|起身|轻咳|呼气|吸气)/;
  return sceneWords.test(t) && !actionVerbs.test(t);
}

function splitByLastPairedQuote(
  s: string,
  open: string,
  close: string
): { narrative: string; speech: string } | null {
  const trimmed = s.trim();
  if (!trimmed.endsWith(close)) return null;
  const closeIdx = trimmed.lastIndexOf(close);
  const openIdx = trimmed.lastIndexOf(open, closeIdx - 1);
  if (openIdx < 0) return null;
  const speech = trimmed.slice(openIdx + open.length, closeIdx);
  const narrative = trimmed.slice(0, openIdx).trimEnd();
  if (!speech.trim()) return null;
  return { narrative, speech: speech.trim() };
}

/**
 * 从「旁白/动作 + 末尾成对白」或已是（）「」格式的字符串中拆出动作与台词。
 */
function splitActionSpeechFromRaw(raw: string): { narrative: string; speech: string } | null {
  const s = raw.trim();
  if (!s) return null;

  let m = s.match(/^（([^）]*)）\s*「([^」]*)」\s*$/);
  if (m)
    return { narrative: (m[1] ?? "").trim(), speech: (m[2] ?? "").trim() };
  m = s.match(/^\(([^)]*)\)\s*「([^」]*)」\s*$/);
  if (m)
    return { narrative: (m[1] ?? "").trim(), speech: (m[2] ?? "").trim() };

  const corner = splitByLastPairedQuote(s, "「", "」");
  if (corner) return corner;
  const curly = splitByLastPairedQuote(s, "\u201c", "\u201d");
  if (curly) return curly;
  const ascii = splitByLastPairedQuote(s, '"', '"');
  if (ascii) return ascii;
  const single = splitByLastPairedQuote(s, "'", "'");
  if (single) return single;

  return null;
}

function legacyExtractSpeech(raw: string): string {
  const s = raw.trim();
  const quoteMatches = [...s.matchAll(/[「“"'‘]([\s\S]{1,2000}?)[」”"'’]/g)]
    .map((m) => cleanQuoted(m[1] ?? ""))
    .filter((x) => x.length >= 1);
  if (quoteMatches.length > 0) {
    quoteMatches.sort((a, b) => b.length - a.length);
    return quoteMatches[0];
  }
  const colonTail = s.match(/[：:]\s*([^：:\n]+)$/);
  if (colonTail?.[1]) {
    const t = cleanQuoted(colonTail[1]);
    if (t.length >= 1) return t;
  }
  const deAction = s
    .replace(/[（(][^）)]*[）)]/g, " ")
    .replace(/\*[^*]*\*/g, " ")
    .replace(/\{\{char\}\}\s*[：:]/gi, " ")
    .trim();
  const tail = deAction
    .split(/[。！？!?]/)
    .map((x) => x.trim())
    .filter(Boolean)
    .pop();
  if (tail) {
    const t = cleanQuoted(tail);
    if (t.length >= 1) return t;
  }
  return "我在。";
}

/** 无明确「叙事+引号」拆分时，尽量保留完整动作片段（不再按首逗号硬截断）。 */
function legacyExtractFullAction(raw: string): string {
  const s = raw.trim();
  const leadingParen = s.match(/^[（(]([^）)]+)[）)]/);
  if (leadingParen?.[1]?.trim()) {
    const inner = leadingParen[1].trim();
    const head = inner.split(/[，,]/)[0]?.trim() || "";
    if (inner && !(head && looksLikeSceneLabel(head))) {
      return inner;
    }
    if (inner && !looksLikeSceneLabel(inner)) return inner;
  }
  const star = s.match(/^\*([^*]+)\*/);
  if (star?.[1]?.trim()) return star[1].trim();
  const noQuote = s
    .replace(/[「]([\s\S]*?)[」]/g, " ")
    .replace(/\u201c([\s\S]*?)\u201d/g, " ")
    .replace(/"([\s\S]*?)"/g, " ")
    .replace(/'([\s\S]*?)'/g, " ")
    .replace(/\{\{char\}\}\s*[：:]/gi, " ")
    .trim();
  if (noQuote) {
    const first = noQuote.split(/[。！？!?]/)[0]?.trim() ?? "";
    if (first) return first.trim();
    return noQuote.trim();
  }
  return "看向你";
}

function normalizeActionSpeech(raw: string, charName: string): string {
  const src = raw.trim();
  if (!src) return "（点头示意）「我在。」";

  const split = splitActionSpeechFromRaw(src);
  let action: string;
  let speech: string;

  if (split && split.speech) {
    action = unwrapAsteriskNarrative(split.narrative);
    speech = cleanQuoted(split.speech);
  } else {
    action = legacyExtractFullAction(src);
    speech = cleanQuoted(legacyExtractSpeech(src));
  }

  action = trimActionTailPunctuation(stripLeadingCharName(action, charName));
  if (!split && looksLikeSceneLabel(action)) {
    action = "看向你";
  }

  if (!speech) speech = "我在。";
  if (!action) action = "看向你";

  action = shorten(action, MAX_GREETING_ACTION_CHARS);
  speech = shorten(speech, MAX_GREETING_SPEECH_CHARS);

  return `（${action}）「${speech}」`;
}

function normalizeMesExample(raw: string, charName: string): string {
  const segments: string[] = [];
  const charMatches = [...raw.matchAll(/\{\{char\}\}\s*[：:]\s*([^\n]+)/gi)];
  for (const m of charMatches) {
    const content = (m[1] ?? "").trim();
    if (content) segments.push(content);
  }
  if (segments.length === 0) {
    const lines = raw
      .split("\n")
      .map((x) => x.trim())
      .filter(
        (x) =>
          x.length > 0 &&
          !x.includes("<START>") &&
          !/\{\{user\}\}/i.test(x) &&
          !/\{\{char\}\}/i.test(x)
      );
    segments.push(...lines);
  }
  const normalized = segments
    .slice(0, 6)
    .map((s) => normalizeActionSpeech(s, charName))
    .filter((s) => s.length > 0);
  return normalized.join("\n");
}

function normalizeCharacterCardFields(item: Record<string, unknown>): void {
  const card = item.character_card;
  if (!isPlainObject(card)) return;

  const charName =
    (typeof card.name === "string" && card.name.trim()) ||
    (typeof item.name === "string" && item.name.trim()) ||
    "";

  const firstMes = typeof card.first_mes === "string" ? card.first_mes : "";
  if (firstMes.trim()) {
    card.first_mes = normalizeActionSpeech(firstMes, charName);
  }

  if (Array.isArray(card.alternate_greetings)) {
    card.alternate_greetings = card.alternate_greetings
      .map((g) => (typeof g === "string" ? g : ""))
      .map((g) => normalizeActionSpeech(g, charName))
      .filter((g) => g.trim().length > 0);
  }

  const mesExample = typeof card.mes_example === "string" ? card.mes_example : "";
  if (mesExample.trim()) {
    card.mes_example = normalizeMesExample(mesExample, charName);
  }
}

function fieldMustBeArray(
  root: Record<string, unknown>,
  key:
    | "entities"
    | "relations"
    | "rules"
    | "timeline"
    | "lore_entries"
    | "locks"
    | "warnings",
  errors: string[]
): unknown[] {
  if (!(key in root)) return [];
  const v = root[key as string];
  if (!Array.isArray(v)) {
    errors.push(`Field "${key}" must be an array if present.`);
    return [];
  }
  return v;
}

function parseOptionalWorldBook(
  root: Record<string, unknown>,
  errors: string[]
): WorldLorebookArtifact | undefined {
  if (!("world_book" in root) || root.world_book === undefined) {
    return undefined;
  }
  const wb = root.world_book;
  if (!isPlainObject(wb)) {
    errors.push('Field "world_book" must be an object if present.');
    return undefined;
  }
  let entries: LorebookEntryRecord[] = [];
  if ("entries" in wb) {
    const e = wb.entries;
    if (e === undefined) {
      entries = [];
    } else if (!Array.isArray(e)) {
      errors.push('Field "world_book.entries" must be an array if present.');
      return undefined;
    } else {
      for (let i = 0; i < e.length; i++) {
        if (!isPlainObject(e[i])) {
          errors.push(
            `Field "world_book.entries[${i}]" must be an object if present.`
          );
          return undefined;
        }
      }
      entries = e as LorebookEntryRecord[];
    }
  }
  return { ...wb, entries };
}

function parseOptionalCharacterBooks(
  root: Record<string, unknown>,
  errors: string[]
): CharacterLorebookArtifact[] | undefined {
  if (!("character_books" in root) || root.character_books === undefined) {
    return undefined;
  }
  if (!Array.isArray(root.character_books)) {
    errors.push('Field "character_books" must be an array if present.');
    return undefined;
  }
  const arr = root.character_books;
  const out: CharacterLorebookArtifact[] = [];
  for (let i = 0; i < arr.length; i++) {
    const item = arr[i];
    if (!isPlainObject(item)) {
      errors.push(`Field "character_books[${i}]" must be an object.`);
      return undefined;
    }
    let entries: LorebookEntryRecord[] = [];
    if ("entries" in item) {
      const e = item.entries;
      if (e === undefined) {
        entries = [];
      } else if (!Array.isArray(e)) {
        errors.push(
          `Field "character_books[${i}].entries" must be an array if present.`
        );
        return undefined;
      } else {
        for (let j = 0; j < e.length; j++) {
          if (!isPlainObject(e[j])) {
            errors.push(
              `Field "character_books[${i}].entries[${j}]" must be an object if present.`
            );
            return undefined;
          }
        }
        entries = e as LorebookEntryRecord[];
      }
    }
    const normalizedItem: CharacterLorebookArtifact = { ...item, entries };
    normalizeCharacterCardFields(normalizedItem as Record<string, unknown>);
    out.push(normalizedItem);
  }
  return out;
}

/**
 * Parse raw JSON text, validate shape, return normalized canonical object + compact JSON string.
 */
export function parseAndValidateCanonicalWorld(raw: string): ValidateResult {
  const errors: string[] = [];
  const encoder = new TextEncoder();
  if (encoder.encode(raw).length > MAX_RAW_BYTES) {
    return { ok: false, errors: [`Payload too large (max ${MAX_RAW_BYTES} bytes).`] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return { ok: false, errors: ["Invalid JSON: could not parse."] };
  }

  if (!isPlainObject(parsed)) {
    return { ok: false, errors: ["Root value must be a JSON object."] };
  }

  const root = parsed;

  if ("meta" in root) {
    if (!isPlainObject(root.meta)) {
      errors.push('Field "meta" must be an object if present.');
    }
  }

  const entities = fieldMustBeArray(root, "entities", errors);
  const relations = fieldMustBeArray(root, "relations", errors);
  const rules = fieldMustBeArray(root, "rules", errors);
  const timeline = fieldMustBeArray(root, "timeline", errors);
  const lore_entries = fieldMustBeArray(root, "lore_entries", errors);
  const locks = fieldMustBeArray(root, "locks", errors);
  const warnings = fieldMustBeArray(root, "warnings", errors);

  const meta =
    "meta" in root && isPlainObject(root.meta) ? { ...root.meta } : {};

  const world_book = parseOptionalWorldBook(root, errors);
  const character_books = parseOptionalCharacterBooks(root, errors);

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const canonical: CanonicalWorld = {
    meta,
    entities,
    relations,
    rules,
    timeline,
    lore_entries,
    locks,
    warnings,
  };
  if (world_book !== undefined) {
    canonical.world_book = world_book;
  }
  if (character_books !== undefined) {
    canonical.character_books = character_books;
  }

  const normalizedJson = JSON.stringify(canonical);
  return { ok: true, canonical, normalizedJson };
}
