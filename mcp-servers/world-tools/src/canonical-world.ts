/**
 * 与 apps/web/src/lib/canonical-world.ts 对齐的最小 Canonical 校验。
 */
export type ValidateResult =
  | { ok: true; normalizedJson: string }
  | { ok: false; errors: string[] };

const MAX_RAW_BYTES = 512 * 1024;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fieldMustBeArray(
  root: Record<string, unknown>,
  key: string,
  errors: string[]
): unknown[] {
  if (!(key in root)) return [];
  const v = root[key];
  if (!Array.isArray(v)) {
    errors.push(`Field "${key}" must be an array if present.`);
    return [];
  }
  return v;
}

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

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const canonical = {
    meta,
    entities,
    relations,
    rules,
    timeline,
    lore_entries,
    locks,
    warnings,
  };

  return { ok: true, normalizedJson: JSON.stringify(canonical) };
}
