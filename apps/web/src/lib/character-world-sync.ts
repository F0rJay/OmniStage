/**
 * 从 Canonical JSON 提取可同步到 tavern_characters 的人物卡（character_books[].character_card）。
 * 供世界版本保存时自动 upsert 角色库使用。
 */

export type SyncedCharacterFromCanonical = {
  /** 与 (user_id, sync_world_id) 组成唯一键；缺 bound_entity_id 时用序号占位 */
  stableKey: string;
  displayName: string;
  /** 已 JSON.stringify 的角色卡对象 */
  characterCardJson: string;
};

/**
 * @returns
 * - `null`：不执行同步（JSON 无效、或根对象上**没有** `character_books` 字段 —— 兼容旧数据）
 * - `[]`：`character_books` 为空数组，应删除该世界下所有「世界同步」角色
 * - 非空数组：按条 upsert
 */
export function extractSyncedCharactersFromCanonical(
  canonicalJson: string
): SyncedCharacterFromCanonical[] | null {
  const raw = canonicalJson?.trim();
  if (!raw) return null;
  let root: unknown;
  try {
    root = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (!root || typeof root !== "object" || Array.isArray(root)) {
    return null;
  }
  const o = root as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(o, "character_books")) {
    return null;
  }
  const books = o.character_books;
  if (!Array.isArray(books)) {
    return null;
  }

  const out: SyncedCharacterFromCanonical[] = [];
  for (let i = 0; i < books.length; i++) {
    const b = books[i];
    if (!b || typeof b !== "object" || Array.isArray(b)) continue;
    const book = b as Record<string, unknown>;
    const card = book.character_card;
    if (
      card === null ||
      card === undefined ||
      typeof card !== "object" ||
      Array.isArray(card)
    ) {
      continue;
    }
    const bid = typeof book.bound_entity_id === "string" ? book.bound_entity_id.trim() : "";
    const stableKey = bid || `__book_${i}`;
    const bname =
      (typeof book.bound_entity_name === "string" && book.bound_entity_name.trim()) || "";
    const nm = (typeof book.name === "string" && book.name.trim()) || "";
    const displayName = bname || nm || stableKey;
    let characterCardJson: string;
    try {
      characterCardJson = JSON.stringify(card);
    } catch {
      continue;
    }
    if (!characterCardJson || characterCardJson === "{}") {
      continue;
    }
    out.push({ stableKey, displayName, characterCardJson });
  }
  return out;
}
