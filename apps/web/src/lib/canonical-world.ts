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
    out.push({ ...item, entries });
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
