import "server-only";

import { generateObject, zodSchema } from "ai";
import * as z from "zod";
import {
  getDreWorldEntityCatalogMax,
  getDreWorldEntityPickMax,
  isDreWorldEntityAnchorsEnabled,
  isDreWorldEntityLlmPickEnabled,
} from "@/lib/dynamic-rp-config";
import { getLanguageModelForProvider } from "@/lib/llm";

export type DreEntityRow = {
  id: string;
  name: string;
  type: string;
  summary: string;
  aliases: string[];
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function stringField(o: Record<string, unknown>, ...keys: string[]): string {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "string" && v.trim().length > 0) return v.trim();
  }
  return "";
}

function aliasesFrom(o: Record<string, unknown>): string[] {
  const raw = o.aliases ?? o.alias ?? o.nicknames;
  if (Array.isArray(raw)) {
    return raw
      .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
      .map((x) => x.trim().slice(0, 64))
      .slice(0, 8);
  }
  if (typeof raw === "string" && raw.trim()) {
    return raw
      .split(/[,，、|]/)
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 8);
  }
  return [];
}

/** 从 Canonical `entities` 数组抽取可展示行（宽松字段）。 */
export function extractDreEntityCatalog(canonicalJson: string): DreEntityRow[] {
  let root: unknown;
  try {
    root = JSON.parse(canonicalJson) as unknown;
  } catch {
    return [];
  }
  if (!isPlainObject(root)) return [];
  const entities = root.entities;
  if (!Array.isArray(entities)) return [];

  const cap = getDreWorldEntityCatalogMax();
  const out: DreEntityRow[] = [];

  for (let i = 0; i < entities.length && out.length < cap; i++) {
    const e = entities[i];
    if (!isPlainObject(e)) continue;
    const name = stringField(e, "name", "title", "label", "display_name");
    if (!name) continue;
    const id =
      stringField(e, "id", "entity_id", "uuid", "key") ||
      `entity_index_${i}`;
    const typ = stringField(e, "type", "kind", "category", "role") || "entity";
    const summary = stringField(
      e,
      "summary",
      "description",
      "desc",
      "bio",
      "notes"
    ).slice(0, 280);
    out.push({
      id: id.slice(0, 128),
      name: name.slice(0, 120),
      type: typ.slice(0, 64),
      summary,
      aliases: aliasesFrom(e),
    });
  }

  return out;
}

function scoreEntity(
  userLine: string,
  snippet: string | null,
  row: DreEntityRow
): number {
  const hay = `${userLine}\n${snippet ?? ""}`.toLowerCase();
  let s = 0;
  const name = row.name.toLowerCase();
  if (name.length >= 2 && hay.includes(name)) s += 8;
  if (name.length === 1 && hay.includes(name)) s += 2;
  for (const a of row.aliases) {
    const al = a.toLowerCase();
    if (al.length >= 2 && hay.includes(al)) s += 5;
  }
  const idShort = row.id.toLowerCase();
  if (idShort.length >= 4 && hay.includes(idShort)) s += 4;
  if (row.summary.length >= 4) {
    const frag = row.summary.slice(0, 16).toLowerCase();
    if (frag.length >= 4 && hay.includes(frag)) s += 2;
  }
  return s;
}

export function pickEntitiesHeuristic(
  userLine: string,
  lastAssistantSnippet: string | null,
  catalog: DreEntityRow[],
  maxPick: number
): DreEntityRow[] {
  if (catalog.length === 0 || maxPick <= 0) return [];
  const scored = catalog.map((row) => ({
    row,
    score: scoreEntity(userLine, lastAssistantSnippet, row),
  }));
  scored.sort((a, b) => b.score - a.score);
  const positive = scored.filter((x) => x.score > 0).map((x) => x.row);
  if (positive.length > 0) {
    return positive.slice(0, maxPick);
  }
  return [];
}

const LlmPickSchema = z.object({
  /** 1-based 行号，对应下列「候选表」 */
  relevant_indices: z.array(z.number().int().min(1).max(500)).max(16),
});

async function refinePickWithLlm(input: {
  userLine: string;
  lastAssistantSnippet: string | null;
  /** 已按启发式排序的候选，取前 N 行给模型选 */
  candidates: DreEntityRow[];
  provider: string;
  modelId: string;
}): Promise<DreEntityRow[]> {
  const maxPick = getDreWorldEntityPickMax();
  const lines = input.candidates.map((r, i) => {
    const al = r.aliases.length ? ` 别名:${r.aliases.join("、")}` : "";
    const sum = r.summary ? ` ${r.summary.slice(0, 80)}` : "";
    return `${i + 1}. [${r.id}] ${r.name}（${r.type}）${al}${sum}`;
  });

  const model = getLanguageModelForProvider(input.provider, input.modelId);
  const r = await generateObject({
    model,
    schema: zodSchema(LlmPickSchema),
    prompt: `你是 TRPG 设定检索器。根据玩家本句与上文摘要，从下列**编号实体**中选出与当前场面最相关的条目（可少选，勿编造表中不存在的编号）。

玩家：${input.userLine.trim().slice(0, 1200)}
叙事摘要：${(input.lastAssistantSnippet ?? "").trim().slice(0, 800)}

【候选表】
${lines.join("\n")}

输出 relevant_indices 为相关行的编号（1 起），最多 ${maxPick} 个。`,
    maxOutputTokens: 120,
  });

  const picked: DreEntityRow[] = [];
  const seen = new Set<string>();
  for (const idx of r.object.relevant_indices) {
    const row = input.candidates[idx - 1];
    if (!row || seen.has(row.id)) continue;
    seen.add(row.id);
    picked.push(row);
    if (picked.length >= maxPick) break;
  }
  return picked;
}

function formatAnchorsBlock(rows: DreEntityRow[]): string {
  if (rows.length === 0) return "";
  const lines = rows.map((r) => {
    const al = r.aliases.length ? `；别名：${r.aliases.join("、")}` : "";
    const sum = r.summary ? ` ${r.summary}` : "";
    return `· [${r.id}] ${r.name}（${r.type}）${al}${sum}`;
  });
  return (
    `【世界书实体锚点（Canonical ID，本回合优先对齐）】\n` +
    `${lines.join("\n")}\n` +
    `叙事中提及上述对象时请与名称/关系一致；勿编造表中不存在的实体 ID。`
  );
}

export type DreWorldEntityTurnResult = {
  /** 注入环境/NPC 子 Agent 与导演 system 的文本块 */
  hintBlock: string;
  /** 仅导演再追加一份时可与此相同 */
  directorAppend: string;
  sse: {
    method: "heuristic" | "llm";
    pickedIds: string[];
    pickedNames: string[];
  } | null;
};

/**
 * 绑定世界存在时：抽取目录 → 启发式相关实体 → 可选 LLM 精排 → 生成锚点文案。
 */
export async function buildDreWorldEntityContextForTurn(input: {
  canonicalJson: string | null | undefined;
  userLine: string;
  lastAssistantSnippet: string | null;
  provider: string;
  modelId: string;
}): Promise<DreWorldEntityTurnResult> {
  const empty: DreWorldEntityTurnResult = {
    hintBlock: "",
    directorAppend: "",
    sse: null,
  };

  if (!isDreWorldEntityAnchorsEnabled()) return empty;
  const raw = input.canonicalJson?.trim();
  if (!raw) return empty;

  const catalog = extractDreEntityCatalog(raw);
  if (catalog.length === 0) return empty;

  const maxPick = getDreWorldEntityPickMax();
  let method: "heuristic" | "llm" = "heuristic";
  let picked = pickEntitiesHeuristic(
    input.userLine,
    input.lastAssistantSnippet,
    catalog,
    maxPick
  );

  if (
    isDreWorldEntityLlmPickEnabled() &&
    catalog.length > 0
  ) {
    const poolSize = Math.min(48, catalog.length);
    const pool =
      picked.length > 0
        ? [
            ...picked,
            ...catalog.filter((c) => !picked.some((p) => p.id === c.id)),
          ].slice(0, poolSize)
        : catalog.slice(0, poolSize);

    try {
      const llmPicked = await refinePickWithLlm({
        userLine: input.userLine,
        lastAssistantSnippet: input.lastAssistantSnippet,
        candidates: pool,
        provider: input.provider,
        modelId: input.modelId,
      });
      if (llmPicked.length > 0) {
        picked = llmPicked;
        method = "llm";
      }
    } catch {
      /* 保持启发式 */
    }
  }

  if (picked.length === 0) return empty;

  const block = formatAnchorsBlock(picked);
  return {
    hintBlock: block,
    directorAppend: block,
    sse: {
      method,
      pickedIds: picked.map((r) => r.id),
      pickedNames: picked.map((r) => r.name),
    },
  };
}
