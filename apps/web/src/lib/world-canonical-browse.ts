/**
 * 从 Canonical JSON 提取「世界详情」只读列表（不入库、不校验完整 Schema）。
 * 用于世界详情页展示 world_book / character_books / entities。
 */

export type WorldBrowseWorldBookEntry = {
  index: number;
  id: string;
  title: string;
  memo: string;
  enabled: boolean;
  strategy: string;
  position: string;
  order: number | null;
  keysPreview: string;
  contentLength: number;
  /** 正文前若干字，供详情页只读预览 */
  contentPreview: string;
};

export type WorldBrowseCharacterBook = {
  index: number;
  label: string;
  boundEntityId: string;
  boundEntityName: string;
  bookName: string;
  hasCharacterCard: boolean;
  /** 人物书内 Lore 触发条目数 */
  entriesCount: number;
  scenarioPreview: string;
};

export type WorldBrowseEntity = {
  index: number;
  id: string;
  name: string;
  kind: string;
  /** 摘要或描述预览 */
  summary: string;
};

export type WorldBrowseResult = {
  ok: true;
  worldBookArtifactName: string | null;
  worldBookEntries: WorldBrowseWorldBookEntry[];
  characterBooks: WorldBrowseCharacterBook[];
  entities: WorldBrowseEntity[];
};

export type WorldBrowseError = {
  ok: false;
  error: string;
};

export type WorldBrowseOutcome = WorldBrowseResult | WorldBrowseError;

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

function numOrNull(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  return null;
}

function parseWorldBookEntries(wb: Record<string, unknown>): WorldBrowseWorldBookEntry[] {
  const entries = wb.entries;
  if (!Array.isArray(entries)) return [];
  const out: WorldBrowseWorldBookEntry[] = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (!e || typeof e !== "object" || Array.isArray(e)) continue;
    const o = e as Record<string, unknown>;
    const body = str(o.content) || str(o.body);
    const keys = o.keys;
    let keysPreview = "";
    if (Array.isArray(keys)) {
      keysPreview = keys
        .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
        .slice(0, 8)
        .join("、");
      if (keys.length > 8) keysPreview += "…";
    }
    out.push({
      index: i,
      id: str(o.id) || `entry_${i}`,
      title: str(o.title) || str(o.memo) || str(o.id) || `条目 ${i + 1}`,
      memo: str(o.memo),
      enabled: o.enabled !== false,
      strategy: str(o.strategy) || "—",
      position: str(o.position) || "—",
      order: numOrNull(o.order),
      keysPreview: keysPreview || "—",
      contentLength: body.length,
      contentPreview: textPreview(body),
    });
  }
  return out;
}

function textPreview(s: string, max = 120): string {
  const t = s.trim();
  if (!t) return "—";
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

function scenarioPreview(card: Record<string, unknown>): string {
  return textPreview(str(card.scenario));
}

function parseCharacterBooks(arr: unknown): WorldBrowseCharacterBook[] {
  if (!Array.isArray(arr)) return [];
  const out: WorldBrowseCharacterBook[] = [];
  for (let i = 0; i < arr.length; i++) {
    const b = arr[i];
    if (!b || typeof b !== "object" || Array.isArray(b)) continue;
    const o = b as Record<string, unknown>;
    const bid = str(o.bound_entity_id).trim();
    const bname = str(o.bound_entity_name).trim();
    const nm = str(o.name).trim();
    const label = bname || nm || bid || `人物书 ${i + 1}`;
    const card = o.character_card;
    const hasCard =
      card !== null &&
      card !== undefined &&
      typeof card === "object" &&
      !Array.isArray(card);
    const charEntries = Array.isArray(o.entries) ? o.entries.length : 0;
    const cardObj = hasCard ? (card as Record<string, unknown>) : {};
    out.push({
      index: i,
      label,
      boundEntityId: bid || `—`,
      boundEntityName: bname || `—`,
      bookName: nm || `—`,
      hasCharacterCard: hasCard,
      entriesCount: charEntries,
      scenarioPreview: hasCard ? scenarioPreview(cardObj) : "—",
    });
  }
  return out;
}

function parseEntitiesList(arr: unknown): WorldBrowseEntity[] {
  if (!Array.isArray(arr)) return [];
  const out: WorldBrowseEntity[] = [];
  for (let i = 0; i < arr.length; i++) {
    const e = arr[i];
    if (!e || typeof e !== "object" || Array.isArray(e)) continue;
    const o = e as Record<string, unknown>;
    const id = str(o.id).trim() || `idx_${i}`;
    const name =
      str(o.name).trim() ||
      str(o.label).trim() ||
      str(o.title).trim() ||
      id;
    const kind =
      str(o.kind).trim() ||
      str(o.type).trim() ||
      str(o.entity_type).trim() ||
      "—";
    const rawSummary =
      str(o.summary).trim() ||
      str(o.description).trim() ||
      str(o.bio).trim() ||
      "";
    out.push({
      index: i,
      id,
      name,
      kind,
      summary: rawSummary ? textPreview(rawSummary, 160) : "—",
    });
  }
  return out;
}

/** 解析 Canonical JSON 字符串，失败时返回 ok:false */
export function browseCanonicalJson(canonicalJson: string): WorldBrowseOutcome {
  const raw = canonicalJson?.trim();
  if (!raw) {
    return {
      ok: false,
      error: "Canonical 为空。",
    };
  }
  try {
    const root = JSON.parse(raw) as Record<string, unknown>;
    if (!root || typeof root !== "object" || Array.isArray(root)) {
      return { ok: false, error: "Canonical 根节点不是对象。" };
    }

    let worldBookArtifactName: string | null = null;
    let worldBookEntries: WorldBrowseWorldBookEntry[] = [];
    const wb = root.world_book;
    if (wb && typeof wb === "object" && !Array.isArray(wb)) {
      const wbo = wb as Record<string, unknown>;
      worldBookArtifactName = str(wbo.name).trim() || null;
      worldBookEntries = parseWorldBookEntries(wbo);
    }

    const characterBooks = parseCharacterBooks(root.character_books);
    const entities = parseEntitiesList(root.entities);

    return {
      ok: true,
      worldBookArtifactName,
      worldBookEntries,
      characterBooks,
      entities,
    };
  } catch {
    return { ok: false, error: "Canonical 不是合法 JSON。" };
  }
}
