import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { DEFAULT_MODEL } from "@/lib/models";
import {
  parseThreadSessionStateJson,
  sanitizeSessionStatePatch,
} from "@/lib/session-state";
import { extractSyncedCharactersFromCanonical } from "@/lib/character-world-sync";

export type StoredMessage = {
  id: string;
  thread_id: string;
  role: "user" | "assistant" | "system";
  content: string;
  created_at: string;
  /** 本回合助手侧展示名（由正文首行 [CW_SPEAKER:…] 解析并剥离） */
  speaker_label: string | null;
};

export type ThreadRecord = {
  id: string;
  user_id: string;
  title: string;
  model_provider: string;
  model_id: string;
  /** 绑定的世界版本（world_versions.id），用于对话注入 Canonical 设定 */
  world_version_id: string | null;
  /** 玩家人格（SillyTavern Persona 语义），personas.id */
  persona_id: string | null;
  /** 当前扮演角色：匹配 canonical.character_books[].bound_entity_id（或同名兜底） */
  active_character_bound_entity_id: string | null;
  /** AI 酒馆角色（SillyTavern「角色」）：tavern_characters.id，定义助手在本会话中扮演的身份 */
  assistant_character_id: string | null;
  /** Phase C：会话运行时状态（JSON 对象序列化） */
  session_state_json: string;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
};

export type PersonaRecord = {
  id: string;
  user_id: string;
  name: string;
  description: string;
  title: string | null;
  /** 预留：与 ST 人格「位置」对齐，当前注入固定随故事上下文 */
  prompt_position: string;
  created_at: string;
  updated_at: string;
};

/** SillyTavern 式「角色」卡片（用户库，非世界书 canonical） */
export type TavernCharacterRecord = {
  id: string;
  user_id: string;
  name: string;
  /** 逗号分隔标签，便于列表展示与筛选 */
  tags: string;
  /** JSON 对象：description、personality、scenario、first_mes、mes_example 等 */
  character_card_json: string;
  created_at: string;
  updated_at: string;
  /** 由世界书自动同步时：来源世界 worlds.id */
  sync_world_id: string | null;
  /** 与 Canonical character_books[].bound_entity_id 对齐（缺省时为内部占位键） */
  sync_bound_entity_id: string | null;
  /** 最近一次写入该同步行的世界版本 world_versions.id */
  sync_world_version_id: string | null;
};

export type UserModelEndpointRecord = {
  id: string;
  user_id: string;
  name: string;
  provider_type: "openai_compatible";
  base_url: string;
  api_key: string;
  model_id: string;
  created_at: string;
  updated_at: string;
};

type UserModelPreference = {
  provider: string;
  modelId: string;
};

type ListThreadsOptions = {
  provider?: string;
  modelId?: string;
  /** Substring match on title (case-insensitive), no LIKE wildcards */
  q?: string;
  limit?: number;
  offset?: number;
  /** Default: only threads that are not archived */
  archived?: "active" | "archived" | "all";
};

const DATA_DIR = path.resolve(process.cwd(), "../../data");
const DB_PATH = path.join(DATA_DIR, "canonweave.sqlite");

let db: Database.Database | null = null;

function getDb(): Database.Database {
  if (db) return db;

  fs.mkdirSync(DATA_DIR, { recursive: true });
  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  const conn = db;

  conn.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      default_model_provider TEXT NOT NULL DEFAULT 'openai',
      default_model_id TEXT NOT NULL DEFAULT 'gpt-4o-mini',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS threads (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT 'Untitled Session',
      model_provider TEXT NOT NULL DEFAULT 'openai',
      model_id TEXT NOT NULL DEFAULT 'gpt-4o-mini',
      archived_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('system', 'user', 'assistant')),
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS worlds (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS world_versions (
      id TEXT PRIMARY KEY,
      world_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      canonical_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(world_id, version),
      FOREIGN KEY (world_id) REFERENCES worlds(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_threads_user_id ON threads(user_id);
    CREATE INDEX IF NOT EXISTS idx_messages_thread_id ON messages(thread_id);
    CREATE INDEX IF NOT EXISTS idx_worlds_user_id ON worlds(user_id);
    CREATE INDEX IF NOT EXISTS idx_world_versions_world_id ON world_versions(world_id);

    CREATE TABLE IF NOT EXISTS session_event_logs (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      payload TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_session_event_logs_thread
      ON session_event_logs(thread_id, created_at);

    CREATE TABLE IF NOT EXISTS world_screenwriter_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      world_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (world_id) REFERENCES worlds(id) ON DELETE CASCADE,
      UNIQUE(user_id, world_id)
    );

    CREATE TABLE IF NOT EXISTS world_screenwriter_messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (session_id) REFERENCES world_screenwriter_sessions(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_wss_messages_session
      ON world_screenwriter_messages(session_id, created_at);

    CREATE TABLE IF NOT EXISTS cw_insights (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      world_id TEXT,
      thread_id TEXT,
      summary TEXT NOT NULL,
      scope TEXT NOT NULL CHECK (scope IN ('world', 'user', 'session')),
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_cw_insights_user_created
      ON cw_insights(user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_cw_insights_world_created
      ON cw_insights(world_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_cw_insights_thread_created
      ON cw_insights(thread_id, created_at);

    CREATE TABLE IF NOT EXISTS personas (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      title TEXT,
      prompt_position TEXT NOT NULL DEFAULT 'with_story',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_personas_user ON personas(user_id);

    CREATE TABLE IF NOT EXISTS tavern_characters (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      tags TEXT NOT NULL DEFAULT '',
      character_card_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_tavern_characters_user ON tavern_characters(user_id);

    CREATE TABLE IF NOT EXISTS user_model_endpoints (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      provider_type TEXT NOT NULL DEFAULT 'openai_compatible',
      base_url TEXT NOT NULL,
      api_key TEXT NOT NULL,
      model_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_user_model_endpoints_user
      ON user_model_endpoints(user_id, updated_at DESC);
  `);

  const tavernCharCols = connColumns(conn, "tavern_characters");
  if (!tavernCharCols.has("sync_world_id")) {
    conn.exec("ALTER TABLE tavern_characters ADD COLUMN sync_world_id TEXT;");
  }
  if (!tavernCharCols.has("sync_bound_entity_id")) {
    conn.exec("ALTER TABLE tavern_characters ADD COLUMN sync_bound_entity_id TEXT;");
  }
  if (!tavernCharCols.has("sync_world_version_id")) {
    conn.exec("ALTER TABLE tavern_characters ADD COLUMN sync_world_version_id TEXT;");
  }
  conn.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_tavern_characters_user_world_entity
     ON tavern_characters(user_id, sync_world_id, sync_bound_entity_id)
     WHERE sync_world_id IS NOT NULL AND sync_bound_entity_id IS NOT NULL;`
  );

  const threadColumns = connColumns(conn, "threads");
  if (!threadColumns.has("model_provider")) {
    conn.exec(
      "ALTER TABLE threads ADD COLUMN model_provider TEXT NOT NULL DEFAULT 'openai';"
    );
  }
  if (!threadColumns.has("model_id")) {
    conn.exec(
      "ALTER TABLE threads ADD COLUMN model_id TEXT NOT NULL DEFAULT 'gpt-4o-mini';"
    );
  }
  if (!threadColumns.has("archived_at")) {
    conn.exec("ALTER TABLE threads ADD COLUMN archived_at TEXT;");
  }

  const userColumns = connColumns(conn, "users");
  if (!userColumns.has("default_model_provider")) {
    conn.exec(
      "ALTER TABLE users ADD COLUMN default_model_provider TEXT NOT NULL DEFAULT 'openai';"
    );
  }
  if (!userColumns.has("default_model_id")) {
    conn.exec(
      "ALTER TABLE users ADD COLUMN default_model_id TEXT NOT NULL DEFAULT 'gpt-4o-mini';"
    );
  }

  if (!threadColumns.has("world_version_id")) {
    conn.exec("ALTER TABLE threads ADD COLUMN world_version_id TEXT;");
  }

  const worldVersionColumns = connColumns(conn, "world_versions");
  if (!worldVersionColumns.has("source_raw_json")) {
    conn.exec("ALTER TABLE world_versions ADD COLUMN source_raw_json TEXT;");
  }
  if (!worldVersionColumns.has("restored_from_version_id")) {
    conn.exec(
      "ALTER TABLE world_versions ADD COLUMN restored_from_version_id TEXT;"
    );
  }

  const threadColsAfter = connColumns(conn, "threads");
  if (!threadColsAfter.has("session_state_json")) {
    conn.exec(
      "ALTER TABLE threads ADD COLUMN session_state_json TEXT NOT NULL DEFAULT '{}';"
    );
  }

  let threadColsRp = connColumns(conn, "threads");
  if (!threadColsRp.has("persona_id")) {
    conn.exec("ALTER TABLE threads ADD COLUMN persona_id TEXT;");
    threadColsRp = connColumns(conn, "threads");
  }
  if (!threadColsRp.has("active_character_bound_entity_id")) {
    conn.exec(
      "ALTER TABLE threads ADD COLUMN active_character_bound_entity_id TEXT;"
    );
    threadColsRp = connColumns(conn, "threads");
  }
  if (!threadColsRp.has("assistant_character_id")) {
    conn.exec("ALTER TABLE threads ADD COLUMN assistant_character_id TEXT;");
  }

  const messageCols = connColumns(conn, "messages");
  if (!messageCols.has("speaker_label")) {
    conn.exec("ALTER TABLE messages ADD COLUMN speaker_label TEXT;");
  }

  return conn;
}

function connColumns(conn: Database.Database, tableName: string): Set<string> {
  const rows = conn
    .prepare(`PRAGMA table_info(${tableName})`)
    .all() as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

export function upsertUser(id: string, displayName: string): void {
  const conn = getDb();
  conn
    .prepare(
      `
      INSERT INTO users (id, display_name, default_model_provider, default_model_id)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        display_name = excluded.display_name,
        updated_at = datetime('now')
    `
    )
    .run(
      id,
      displayName,
      DEFAULT_MODEL.provider,
      DEFAULT_MODEL.modelId
    );
}

export function findUserDisplayName(id: string): string | null {
  const conn = getDb();
  const row = conn
    .prepare("SELECT display_name FROM users WHERE id = ? LIMIT 1")
    .get(id) as { display_name: string } | undefined;
  return row?.display_name ?? null;
}

export function ensureThread(threadId: string, userId: string): ThreadRecord {
  const conn = getDb();
  const userModel = getUserModelPreference(userId);
  conn
    .prepare(
      `
      INSERT OR IGNORE INTO threads (id, user_id, model_provider, model_id)
      VALUES (?, ?, ?, ?)
    `
    )
    .run(threadId, userId, userModel.provider, userModel.modelId);

  const row = conn
    .prepare(
      `
      SELECT id, user_id, title, model_provider, model_id, world_version_id, persona_id, active_character_bound_entity_id, assistant_character_id, session_state_json, archived_at, created_at, updated_at
      FROM threads
      WHERE id = ? AND user_id = ?
      LIMIT 1
    `
    )
    .get(threadId, userId) as ThreadRecord | undefined;

  if (!row) {
    throw new Error("Thread is not accessible for this user.");
  }

  return row;
}

export function insertMessage(input: {
  id: string;
  threadId: string;
  role: "user" | "assistant" | "system";
  content: string;
  /** 仅 assistant：气泡旁显示名，与 threads.assistant_character 无关时可按回合切换 */
  speakerLabel?: string | null;
}): void {
  const conn = getDb();
  const sl =
    input.role === "assistant" &&
    input.speakerLabel !== undefined &&
    input.speakerLabel !== null &&
    String(input.speakerLabel).trim().length > 0
      ? String(input.speakerLabel).trim().slice(0, 128)
      : null;

  conn
    .prepare(
      `
      INSERT INTO messages (id, thread_id, role, content, speaker_label)
      VALUES (?, ?, ?, ?, ?)
    `
    )
    .run(input.id, input.threadId, input.role, input.content, sl);

  conn
    .prepare(
      `
      UPDATE threads
      SET updated_at = datetime('now')
      WHERE id = ?
    `
    )
    .run(input.threadId);
}

export function listMessagesByThread(threadId: string, limit = 100): StoredMessage[] {
  const conn = getDb();
  return conn
    .prepare(
      `
      SELECT id, thread_id, role, content, created_at, speaker_label
      FROM messages
      WHERE thread_id = ?
      ORDER BY created_at ASC, rowid ASC
      LIMIT ?
    `
    )
    .all(threadId, limit) as StoredMessage[];
}

export function countUserMessagesInThread(threadId: string): number {
  const conn = getDb();
  const row = conn
    .prepare(
      `
      SELECT COUNT(*) AS c
      FROM messages
      WHERE thread_id = ? AND role = 'user'
    `
    )
    .get(threadId) as { c: number };
  return row.c;
}

/**
 * 浅合并顶层键写入 threads.session_state_json，并返回合并后对象（用于 SSE / 提示词）。
 */
export function mergeThreadSessionState(
  threadId: string,
  userId: string,
  patch: Record<string, unknown>
): { state: Record<string, unknown>; keys: string[] } {
  const thread = ensureThread(threadId, userId);
  const sanitized = sanitizeSessionStatePatch(patch);
  const keys = Object.keys(sanitized);
  const current = parseThreadSessionStateJson(thread.session_state_json);
  if (keys.length === 0) {
    return { state: current, keys: [] };
  }
  const next = { ...current, ...sanitized };
  const conn = getDb();
  conn
    .prepare(
      `
      UPDATE threads
      SET session_state_json = ?, updated_at = datetime('now')
      WHERE id = ? AND user_id = ?
    `
    )
    .run(JSON.stringify(next), threadId, userId);
  return { state: next, keys };
}

export function getDatabasePath(): string {
  return DB_PATH;
}

export function updateThreadModel(
  threadId: string,
  userId: string,
  input: { provider: string; modelId: string }
): void {
  const conn = getDb();
  const result = conn
    .prepare(
      `
      UPDATE threads
      SET model_provider = ?, model_id = ?, updated_at = datetime('now')
      WHERE id = ? AND user_id = ?
    `
    )
    .run(input.provider, input.modelId, threadId, userId);

  if (result.changes === 0) {
    throw new Error("Thread is not accessible for this user.");
  }
}

export function getUserModelPreference(userId: string): UserModelPreference {
  const conn = getDb();
  const row = conn
    .prepare(
      `
      SELECT default_model_provider, default_model_id
      FROM users
      WHERE id = ?
      LIMIT 1
    `
    )
    .get(userId) as
    | { default_model_provider: string; default_model_id: string }
    | undefined;

  if (!row) {
    return {
      provider: DEFAULT_MODEL.provider,
      modelId: DEFAULT_MODEL.modelId,
    };
  }

  return {
    provider: row.default_model_provider,
    modelId: row.default_model_id,
  };
}

export function updateUserModelPreference(
  userId: string,
  input: { provider: string; modelId: string }
): void {
  const conn = getDb();
  const result = conn
    .prepare(
      `
      UPDATE users
      SET default_model_provider = ?, default_model_id = ?, updated_at = datetime('now')
      WHERE id = ?
    `
    )
    .run(input.provider, input.modelId, userId);

  if (result.changes === 0) {
    throw new Error("User is not found.");
  }
}

export function listUserModelEndpoints(userId: string): UserModelEndpointRecord[] {
  const conn = getDb();
  return conn
    .prepare(
      `
      SELECT id, user_id, name, provider_type, base_url, api_key, model_id, created_at, updated_at
      FROM user_model_endpoints
      WHERE user_id = ?
      ORDER BY updated_at DESC, created_at DESC
      `
    )
    .all(userId) as UserModelEndpointRecord[];
}

export function getUserModelEndpointById(
  endpointId: string
): UserModelEndpointRecord | null {
  const conn = getDb();
  const row = conn
    .prepare(
      `
      SELECT id, user_id, name, provider_type, base_url, api_key, model_id, created_at, updated_at
      FROM user_model_endpoints
      WHERE id = ?
      LIMIT 1
      `
    )
    .get(endpointId) as UserModelEndpointRecord | undefined;
  return row ?? null;
}

export function getUserModelEndpointForUser(
  userId: string,
  endpointId: string
): UserModelEndpointRecord | null {
  const conn = getDb();
  const row = conn
    .prepare(
      `
      SELECT id, user_id, name, provider_type, base_url, api_key, model_id, created_at, updated_at
      FROM user_model_endpoints
      WHERE user_id = ? AND id = ?
      LIMIT 1
      `
    )
    .get(userId, endpointId) as UserModelEndpointRecord | undefined;
  return row ?? null;
}

export function createUserModelEndpoint(
  userId: string,
  input: {
    name: string;
    baseUrl: string;
    apiKey: string;
    modelId: string;
  }
): UserModelEndpointRecord {
  const conn = getDb();
  const id = randomUUID();
  conn
    .prepare(
      `
      INSERT INTO user_model_endpoints
        (id, user_id, name, provider_type, base_url, api_key, model_id)
      VALUES (?, ?, ?, 'openai_compatible', ?, ?, ?)
      `
    )
    .run(
      id,
      userId,
      input.name.trim().slice(0, 80),
      input.baseUrl.trim().replace(/\/+$/, ""),
      input.apiKey.trim(),
      input.modelId.trim().slice(0, 120)
    );
  return getUserModelEndpointForUser(userId, id)!;
}

export function deleteUserModelEndpoint(userId: string, endpointId: string): void {
  const conn = getDb();
  conn
    .prepare(
      `
      DELETE FROM user_model_endpoints
      WHERE user_id = ? AND id = ?
      `
    )
    .run(userId, endpointId);
}

export function createThreadForUser(
  userId: string,
  title = "New Session",
  worldVersionId?: string | null
): ThreadRecord {
  const conn = getDb();
  const preference = getUserModelPreference(userId);
  const id = randomUUID();

  let boundVersion: string | null = null;
  const rawWv = worldVersionId?.trim();
  if (rawWv) {
    const bundle = getWorldVersionWithWorldForUser(rawWv, userId);
    if (!bundle) {
      throw new Error("World version not found or inaccessible.");
    }
    boundVersion = bundle.versionRow.id;
  }

  conn
    .prepare(
      `
      INSERT INTO threads (id, user_id, title, model_provider, model_id, world_version_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `
    )
    .run(id, userId, title, preference.provider, preference.modelId, boundVersion);

  return ensureThread(id, userId);
}

export function getLatestThreadForUser(userId: string): ThreadRecord | null {
  const conn = getDb();
  const row = conn
    .prepare(
      `
      SELECT id, user_id, title, model_provider, model_id, world_version_id, persona_id, active_character_bound_entity_id, assistant_character_id, session_state_json, archived_at, created_at, updated_at
      FROM threads
      WHERE user_id = ? AND archived_at IS NULL
      ORDER BY updated_at DESC, created_at DESC
      LIMIT 1
    `
    )
    .get(userId) as ThreadRecord | undefined;

  return row ?? null;
}

function buildThreadListWhere(
  userId: string,
  options: ListThreadsOptions
): { whereSql: string; params: Array<string | number> } {
  const clauses = ["user_id = ?"];
  const params: Array<string | number> = [userId];

  const archivedMode = options.archived ?? "active";
  if (archivedMode === "active") {
    clauses.push("archived_at IS NULL");
  } else if (archivedMode === "archived") {
    clauses.push("archived_at IS NOT NULL");
  }

  if (options.provider) {
    clauses.push("model_provider = ?");
    params.push(options.provider);
  }
  if (options.modelId) {
    clauses.push("model_id = ?");
    params.push(options.modelId);
  }
  const q = options.q?.trim();
  if (q) {
    clauses.push("instr(lower(title), lower(?)) > 0");
    params.push(q.slice(0, 120));
  }

  return { whereSql: clauses.join(" AND "), params };
}

export function countThreadsForUser(
  userId: string,
  options: Omit<ListThreadsOptions, "limit" | "offset"> = {}
): number {
  const conn = getDb();
  const { whereSql, params } = buildThreadListWhere(userId, options);
  const row = conn
    .prepare(
      `
      SELECT COUNT(*) AS c
      FROM threads
      WHERE ${whereSql}
    `
    )
    .get(...params) as { c: number };
  return row.c;
}

export function listThreadsForUser(
  userId: string,
  options: ListThreadsOptions = {}
): ThreadRecord[] {
  const conn = getDb();
  const { whereSql, params } = buildThreadListWhere(userId, options);

  const limit = Math.max(1, Math.min(options.limit ?? 30, 100));
  const offset = Math.max(0, Math.min(options.offset ?? 0, 1_000_000));
  const listParams = [...params, limit, offset];

  return conn
    .prepare(
      `
      SELECT id, user_id, title, model_provider, model_id, world_version_id, persona_id, active_character_bound_entity_id, assistant_character_id, session_state_json, archived_at, created_at, updated_at
      FROM threads
      WHERE ${whereSql}
      ORDER BY updated_at DESC, created_at DESC
      LIMIT ? OFFSET ?
    `
    )
    .all(...listParams) as ThreadRecord[];
}

export function renameThread(
  threadId: string,
  userId: string,
  title: string
): ThreadRecord {
  const conn = getDb();
  const result = conn
    .prepare(
      `
      UPDATE threads
      SET title = ?, updated_at = datetime('now')
      WHERE id = ? AND user_id = ?
    `
    )
    .run(title, threadId, userId);

  if (result.changes === 0) {
    throw new Error("Thread is not accessible for this user.");
  }

  return ensureThread(threadId, userId);
}

export function setThreadArchived(
  threadId: string,
  userId: string,
  archived: boolean
): ThreadRecord {
  const conn = getDb();
  const result = archived
    ? conn
        .prepare(
          `
          UPDATE threads
          SET archived_at = datetime('now'), updated_at = datetime('now')
          WHERE id = ? AND user_id = ? AND archived_at IS NULL
        `
        )
        .run(threadId, userId)
    : conn
        .prepare(
          `
          UPDATE threads
          SET archived_at = NULL, updated_at = datetime('now')
          WHERE id = ? AND user_id = ? AND archived_at IS NOT NULL
        `
        )
        .run(threadId, userId);

  if (result.changes === 0) {
    throw new Error("Thread is not accessible for this user.");
  }

  return ensureThread(threadId, userId);
}

/**
 * 永久删除会话：消息与 session_event_logs 随 threads 行级 CASCADE；
 * cw_insights 中 thread_id 无外键，需显式清理。
 */
export function permanentlyDeleteThreadForUser(
  threadId: string,
  userId: string
): void {
  const conn = getDb();
  const row = conn
    .prepare(`SELECT id FROM threads WHERE id = ? AND user_id = ? LIMIT 1`)
    .get(threadId, userId) as { id: string } | undefined;
  if (!row) {
    throw new Error("Thread is not accessible for this user.");
  }
  conn.prepare(`DELETE FROM cw_insights WHERE thread_id = ?`).run(threadId);
  const result = conn
    .prepare(`DELETE FROM threads WHERE id = ? AND user_id = ?`)
    .run(threadId, userId);
  if (result.changes === 0) {
    throw new Error("Thread is not accessible for this user.");
  }
}

/* --- Worlds & world_versions (Phase B foundation) --- */

export type WorldRecord = {
  id: string;
  user_id: string;
  name: string;
  description: string;
  created_at: string;
  updated_at: string;
};

export type WorldVersionRecord = {
  id: string;
  world_id: string;
  version: number;
  canonical_json: string;
  created_at: string;
  /** 导入时用户粘贴的原文（审计 / 重试） */
  source_raw_json: string | null;
  /** 若本版本由「从历史恢复」生成，指向源 world_versions.id */
  restored_from_version_id: string | null;
};

type ListWorldsOptions = {
  q?: string;
  limit?: number;
  offset?: number;
};

function buildWorldListWhere(
  userId: string,
  options: Pick<ListWorldsOptions, "q">
): { whereSql: string; params: Array<string | number> } {
  const clauses = ["user_id = ?"];
  const params: Array<string | number> = [userId];
  const q = options.q?.trim();
  if (q) {
    clauses.push(
      "(instr(lower(name), lower(?)) > 0 OR instr(lower(description), lower(?)) > 0)"
    );
    params.push(q.slice(0, 120), q.slice(0, 120));
  }
  return { whereSql: clauses.join(" AND "), params };
}

export function countWorldsForUser(
  userId: string,
  options: Pick<ListWorldsOptions, "q"> = {}
): number {
  const conn = getDb();
  const { whereSql, params } = buildWorldListWhere(userId, options);
  const row = conn
    .prepare(
      `
      SELECT COUNT(*) AS c
      FROM worlds
      WHERE ${whereSql}
    `
    )
    .get(...params) as { c: number };
  return row.c;
}

export function listWorldsForUser(
  userId: string,
  options: ListWorldsOptions = {}
): WorldRecord[] {
  const conn = getDb();
  const { whereSql, params } = buildWorldListWhere(userId, options);
  const limit = Math.max(1, Math.min(options.limit ?? 30, 100));
  const offset = Math.max(0, Math.min(options.offset ?? 0, 1_000_000));
  return conn
    .prepare(
      `
      SELECT id, user_id, name, description, created_at, updated_at
      FROM worlds
      WHERE ${whereSql}
      ORDER BY updated_at DESC, created_at DESC
      LIMIT ? OFFSET ?
    `
    )
    .all(...params, limit, offset) as WorldRecord[];
}

export function getWorldForUser(
  worldId: string,
  userId: string
): WorldRecord | null {
  const conn = getDb();
  const row = conn
    .prepare(
      `
      SELECT id, user_id, name, description, created_at, updated_at
      FROM worlds
      WHERE id = ? AND user_id = ?
      LIMIT 1
    `
    )
    .get(worldId, userId) as WorldRecord | undefined;
  return row ?? null;
}

export function updateWorldForUser(
  worldId: string,
  userId: string,
  input: { name?: string; description?: string }
): WorldRecord {
  const world = getWorldForUser(worldId, userId);
  if (!world) {
    throw new Error("World is not accessible for this user.");
  }
  const name =
    input.name !== undefined
      ? input.name.trim().slice(0, 120)
      : world.name;
  const description =
    input.description !== undefined
      ? input.description.trim().slice(0, 2000)
      : world.description;
  if (!name) {
    throw new Error("World name is required.");
  }
  const conn = getDb();
  conn
    .prepare(
      `
      UPDATE worlds
      SET name = ?, description = ?, updated_at = datetime('now')
      WHERE id = ? AND user_id = ?
    `
    )
    .run(name, description, worldId, userId);

  const next = getWorldForUser(worldId, userId);
  if (!next) throw new Error("Failed to update world.");
  return next;
}

/**
 * 删除世界及其版本、编剧会话（外键级联）；并解除本会话上对该世界任意版本的绑定。
 */
export function deleteWorldForUser(worldId: string, userId: string): void {
  if (!getWorldForUser(worldId, userId)) {
    throw new Error("World is not accessible for this user.");
  }
  const conn = getDb();
  conn
    .prepare(
      `
      UPDATE threads
      SET world_version_id = NULL
      WHERE user_id = ?
        AND world_version_id IS NOT NULL
        AND world_version_id IN (
          SELECT id FROM world_versions WHERE world_id = ?
        )
    `
    )
    .run(userId, worldId);

  const syncedChars = conn
    .prepare(
      `
      SELECT id FROM tavern_characters
      WHERE user_id = ? AND sync_world_id = ?
    `
    )
    .all(userId, worldId) as { id: string }[];
  if (syncedChars.length > 0) {
    const ids = syncedChars.map((r) => r.id);
    const ph = ids.map(() => "?").join(", ");
    conn
      .prepare(
        `
        UPDATE threads
        SET assistant_character_id = NULL, updated_at = datetime('now')
        WHERE user_id = ? AND assistant_character_id IN (${ph})
      `
      )
      .run(userId, ...ids);
    conn
      .prepare(
        `
        DELETE FROM tavern_characters WHERE user_id = ? AND id IN (${ph})
      `
      )
      .run(userId, ...ids);
  }

  const result = conn
    .prepare(`DELETE FROM worlds WHERE id = ? AND user_id = ?`)
    .run(worldId, userId);
  if (result.changes === 0) {
    throw new Error("Failed to delete world.");
  }
}

export function createWorld(
  userId: string,
  input: { name: string; description?: string }
): WorldRecord {
  const conn = getDb();
  const id = randomUUID();
  const name = input.name.trim().slice(0, 120);
  const description = (input.description ?? "").trim().slice(0, 2000);
  if (!name) {
    throw new Error("World name is required.");
  }
  conn
    .prepare(
      `
      INSERT INTO worlds (id, user_id, name, description)
      VALUES (?, ?, ?, ?)
    `
    )
    .run(id, userId, name, description);

  const world = getWorldForUser(id, userId);
  if (!world) throw new Error("Failed to create world.");
  return world;
}

export function listWorldVersionsForWorld(
  worldId: string,
  userId: string
): WorldVersionRecord[] {
  if (!getWorldForUser(worldId, userId)) {
    throw new Error("World is not accessible for this user.");
  }
  const conn = getDb();
  return conn
    .prepare(
      `
      SELECT id, world_id, version, canonical_json, created_at, source_raw_json, restored_from_version_id
      FROM world_versions
      WHERE world_id = ?
      ORDER BY version DESC, created_at DESC
    `
    )
    .all(worldId) as WorldVersionRecord[];
}

export function getOrCreateScreenwriterSession(
  worldId: string,
  userId: string
): string {
  if (!getWorldForUser(worldId, userId)) {
    throw new Error("World is not accessible for this user.");
  }
  const conn = getDb();
  const row = conn
    .prepare(
      `
      SELECT id FROM world_screenwriter_sessions
      WHERE world_id = ? AND user_id = ?
      LIMIT 1
    `
    )
    .get(worldId, userId) as { id: string } | undefined;
  if (row) {
    return row.id;
  }

  const id = randomUUID();
  conn
    .prepare(
      `
      INSERT INTO world_screenwriter_sessions (id, user_id, world_id)
      VALUES (?, ?, ?)
    `
    )
    .run(id, userId, worldId);
  return id;
}

export function listScreenwriterMessages(
  sessionId: string,
  userId: string
): Array<{ role: "user" | "assistant"; content: string }> {
  const conn = getDb();
  const ok = conn
    .prepare(
      `
      SELECT 1 FROM world_screenwriter_sessions
      WHERE id = ? AND user_id = ?
      LIMIT 1
    `
    )
    .get(sessionId, userId);
  if (!ok) {
    throw new Error("Screenwriter session not found.");
  }
  return conn
    .prepare(
      `
      SELECT role, content
      FROM world_screenwriter_messages
      WHERE session_id = ?
      ORDER BY created_at ASC
    `
    )
    .all(sessionId) as Array<{ role: "user" | "assistant"; content: string }>;
}

export function insertScreenwriterMessage(input: {
  sessionId: string;
  userId: string;
  role: "user" | "assistant";
  content: string;
}): void {
  const conn = getDb();
  const ok = conn
    .prepare(
      `
      SELECT 1 FROM world_screenwriter_sessions
      WHERE id = ? AND user_id = ?
      LIMIT 1
    `
    )
    .get(input.sessionId, input.userId);
  if (!ok) {
    throw new Error("Screenwriter session not found.");
  }
  const id = randomUUID();
  conn
    .prepare(
      `
      INSERT INTO world_screenwriter_messages (id, session_id, role, content)
      VALUES (?, ?, ?, ?)
    `
    )
    .run(id, input.sessionId, input.role, input.content);
  conn
    .prepare(
      `
      UPDATE world_screenwriter_sessions
      SET updated_at = datetime('now')
      WHERE id = ?
    `
    )
    .run(input.sessionId);
}

export type WorldVersionWithWorld = {
  versionRow: WorldVersionRecord;
  worldName: string;
};

/** 校验 world_versions 归属当前用户，并带上世界名称 */
export function getWorldVersionWithWorldForUser(
  versionId: string,
  userId: string
): WorldVersionWithWorld | null {
  const conn = getDb();
  const row = conn
    .prepare(
      `
      SELECT
        wv.id AS vid,
        wv.world_id AS wvid,
        wv.version AS vnum,
        wv.canonical_json AS cj,
        wv.created_at AS vca,
        wv.source_raw_json AS srj,
        wv.restored_from_version_id AS rfv,
        w.name AS wname
      FROM world_versions wv
      INNER JOIN worlds w ON w.id = wv.world_id
      WHERE wv.id = ? AND w.user_id = ?
      LIMIT 1
    `
    )
    .get(versionId, userId) as
    | {
        vid: string;
        wvid: string;
        vnum: number;
        cj: string;
        vca: string;
        srj: string | null;
        rfv: string | null;
        wname: string;
      }
    | undefined;

  if (!row) return null;

  return {
    versionRow: {
      id: row.vid,
      world_id: row.wvid,
      version: row.vnum,
      canonical_json: row.cj,
      created_at: row.vca,
      source_raw_json: row.srj ?? null,
      restored_from_version_id: row.rfv ?? null,
    },
    worldName: row.wname,
  };
}

export function updateThreadWorldVersion(
  threadId: string,
  userId: string,
  worldVersionId: string | null
): ThreadRecord {
  const trimmed = worldVersionId?.trim() ?? "";
  let next: string | null = null;
  if (trimmed.length > 0) {
    const bundle = getWorldVersionWithWorldForUser(trimmed, userId);
    if (!bundle) {
      throw new Error("World version not found or inaccessible.");
    }
    next = bundle.versionRow.id;
  }

  const conn = getDb();
  const result = conn
    .prepare(
      `
      UPDATE threads
      SET world_version_id = ?, updated_at = datetime('now')
      WHERE id = ? AND user_id = ?
    `
    )
    .run(next, threadId, userId);

  if (result.changes === 0) {
    throw new Error("Thread is not accessible for this user.");
  }

  return ensureThread(threadId, userId);
}

export function listPersonasForUser(userId: string, limit = 50): PersonaRecord[] {
  const conn = getDb();
  const lim = Math.max(1, Math.min(limit, 100));
  return conn
    .prepare(
      `
      SELECT id, user_id, name, description, title, prompt_position, created_at, updated_at
      FROM personas
      WHERE user_id = ?
      ORDER BY updated_at DESC, created_at DESC
      LIMIT ?
    `
    )
    .all(userId, lim) as PersonaRecord[];
}

export function getPersonaForUser(
  personaId: string,
  userId: string
): PersonaRecord | null {
  const conn = getDb();
  const row = conn
    .prepare(
      `
      SELECT id, user_id, name, description, title, prompt_position, created_at, updated_at
      FROM personas
      WHERE id = ? AND user_id = ?
      LIMIT 1
    `
    )
    .get(personaId, userId) as PersonaRecord | undefined;
  return row ?? null;
}

export function createPersona(
  userId: string,
  input: { name: string; description?: string; title?: string | null }
): PersonaRecord {
  const name = input.name.trim().slice(0, 120);
  if (!name) {
    throw new Error("人格名称不能为空。");
  }
  const description = (input.description ?? "").trim().slice(0, 32_000);
  const title =
    input.title === null || input.title === undefined
      ? null
      : input.title.trim().slice(0, 200) || null;
  const id = randomUUID();
  const conn = getDb();
  conn
    .prepare(
      `
      INSERT INTO personas (id, user_id, name, description, title)
      VALUES (?, ?, ?, ?, ?)
    `
    )
    .run(id, userId, name, description, title);
  return getPersonaForUser(id, userId)!;
}

export function updatePersona(
  personaId: string,
  userId: string,
  input: { name?: string; description?: string; title?: string | null }
): PersonaRecord {
  const existing = getPersonaForUser(personaId, userId);
  if (!existing) {
    throw new Error("人格不存在。");
  }
  const name =
    input.name !== undefined
      ? input.name.trim().slice(0, 120)
      : existing.name;
  if (!name) {
    throw new Error("人格名称不能为空。");
  }
  const description =
    input.description !== undefined
      ? input.description.trim().slice(0, 32_000)
      : existing.description;
  const title =
    input.title === undefined
      ? existing.title
      : input.title === null
        ? null
        : input.title.trim().slice(0, 200) || null;

  const conn = getDb();
  conn
    .prepare(
      `
      UPDATE personas
      SET name = ?, description = ?, title = ?, updated_at = datetime('now')
      WHERE id = ? AND user_id = ?
    `
    )
    .run(name, description, title, personaId, userId);

  return getPersonaForUser(personaId, userId)!;
}

export function deletePersona(personaId: string, userId: string): void {
  const conn = getDb();
  conn
    .prepare(
      `
      UPDATE threads
      SET persona_id = NULL, updated_at = datetime('now')
      WHERE persona_id = ? AND user_id = ?
    `
    )
    .run(personaId, userId);
  const result = conn
    .prepare(`DELETE FROM personas WHERE id = ? AND user_id = ?`)
    .run(personaId, userId);
  if (result.changes === 0) {
    throw new Error("人格不存在。");
  }
}

export function listTavernCharactersForUser(
  userId: string,
  limit = 50
): TavernCharacterRecord[] {
  const conn = getDb();
  const lim = Math.max(1, Math.min(limit, 100));
  return conn
    .prepare(
      `
      SELECT id, user_id, name, tags, character_card_json, created_at, updated_at,
             sync_world_id, sync_bound_entity_id, sync_world_version_id
      FROM tavern_characters
      WHERE user_id = ?
      ORDER BY updated_at DESC, created_at DESC
      LIMIT ?
    `
    )
    .all(userId, lim) as TavernCharacterRecord[];
}

export function getTavernCharacterForUser(
  characterId: string,
  userId: string
): TavernCharacterRecord | null {
  const conn = getDb();
  const row = conn
    .prepare(
      `
      SELECT id, user_id, name, tags, character_card_json, created_at, updated_at,
             sync_world_id, sync_bound_entity_id, sync_world_version_id
      FROM tavern_characters
      WHERE id = ? AND user_id = ?
      LIMIT 1
    `
    )
    .get(characterId, userId) as TavernCharacterRecord | undefined;
  return row ?? null;
}

export function createTavernCharacter(
  userId: string,
  input: {
    name: string;
    tags?: string;
    characterCardJson?: string;
  }
): TavernCharacterRecord {
  const name = input.name.trim().slice(0, 120);
  if (!name) {
    throw new Error("角色名称不能为空。");
  }
  let cardJson = (input.characterCardJson ?? "{}").trim();
  if (!cardJson) {
    cardJson = "{}";
  }
  try {
    JSON.parse(cardJson);
  } catch {
    throw new Error("角色卡 JSON 无效。");
  }
  const tags = (input.tags ?? "").trim().slice(0, 500);
  const id = randomUUID();
  const conn = getDb();
  conn
    .prepare(
      `
      INSERT INTO tavern_characters (id, user_id, name, tags, character_card_json)
      VALUES (?, ?, ?, ?, ?)
    `
    )
    .run(id, userId, name, tags, cardJson);
  return getTavernCharacterForUser(id, userId)!;
}

export function updateTavernCharacter(
  characterId: string,
  userId: string,
  input: { name?: string; tags?: string; characterCardJson?: string }
): TavernCharacterRecord {
  const existing = getTavernCharacterForUser(characterId, userId);
  if (!existing) {
    throw new Error("角色不存在。");
  }
  const name =
    input.name !== undefined
      ? input.name.trim().slice(0, 120)
      : existing.name;
  if (!name) {
    throw new Error("角色名称不能为空。");
  }
  const tags =
    input.tags !== undefined
      ? input.tags.trim().slice(0, 500)
      : existing.tags;
  let cardJson = existing.character_card_json;
  if (input.characterCardJson !== undefined) {
    const raw = input.characterCardJson.trim();
    if (!raw) {
      throw new Error("角色卡 JSON 不能为空。");
    }
    try {
      JSON.parse(raw);
    } catch {
      throw new Error("角色卡 JSON 无效。");
    }
    cardJson = raw;
  }
  const conn = getDb();
  conn
    .prepare(
      `
      UPDATE tavern_characters
      SET name = ?, tags = ?, character_card_json = ?, updated_at = datetime('now')
      WHERE id = ? AND user_id = ?
    `
    )
    .run(name, tags, cardJson, characterId, userId);
  return getTavernCharacterForUser(characterId, userId)!;
}

export function deleteTavernCharacter(characterId: string, userId: string): void {
  const conn = getDb();
  conn
    .prepare(
      `
      UPDATE threads
      SET assistant_character_id = NULL, updated_at = datetime('now')
      WHERE assistant_character_id = ? AND user_id = ?
    `
    )
    .run(characterId, userId);
  const result = conn
    .prepare(`DELETE FROM tavern_characters WHERE id = ? AND user_id = ?`)
    .run(characterId, userId);
  if (result.changes === 0) {
    throw new Error("角色不存在。");
  }
}

/**
 * 更新会话的玩家人格、世界书中扮演条目、以及 AI 酒馆角色（SillyTavern「角色」）
 */
export function updateThreadRpBinding(
  threadId: string,
  userId: string,
  input: {
    personaId?: string | null;
    activeCharacterBoundEntityId?: string | null;
    assistantCharacterId?: string | null;
  }
): ThreadRecord {
  if (
    input.personaId === undefined &&
    input.activeCharacterBoundEntityId === undefined &&
    input.assistantCharacterId === undefined
  ) {
    throw new Error(
      "请提供 personaId、activeCharacterBoundEntityId 和/或 assistantCharacterId。"
    );
  }

  const thread = ensureThread(threadId, userId);
  let personaId: string | null = thread.persona_id ?? null;
  let charId: string | null = thread.active_character_bound_entity_id ?? null;
  let assistantCharacterId: string | null =
    thread.assistant_character_id ?? null;

  if (input.personaId !== undefined) {
    if (input.personaId === null || input.personaId === "") {
      personaId = null;
    } else {
      const pid = input.personaId.trim();
      if (!getPersonaForUser(pid, userId)) {
        throw new Error("人格不存在或无权访问。");
      }
      personaId = pid;
    }
  }

  if (input.activeCharacterBoundEntityId !== undefined) {
    const raw = input.activeCharacterBoundEntityId;
    if (raw === null || raw === "") {
      charId = null;
    } else {
      charId = raw.trim().slice(0, 256);
    }
  }

  if (input.assistantCharacterId !== undefined) {
    if (input.assistantCharacterId === null || input.assistantCharacterId === "") {
      assistantCharacterId = null;
    } else {
      const aid = input.assistantCharacterId.trim();
      if (!getTavernCharacterForUser(aid, userId)) {
        throw new Error("酒馆角色不存在或无权访问。");
      }
      assistantCharacterId = aid;
    }
  }

  const conn = getDb();
  const result = conn
    .prepare(
      `
      UPDATE threads
      SET persona_id = ?,
          active_character_bound_entity_id = ?,
          assistant_character_id = ?,
          updated_at = datetime('now')
      WHERE id = ? AND user_id = ?
    `
    )
    .run(personaId, charId, assistantCharacterId, threadId, userId);

  if (result.changes === 0) {
    throw new Error("会话不可访问。");
  }

  return ensureThread(threadId, userId);
}

export type WorldWithVersionSummaries = WorldRecord & {
  versions: Array<{ id: string; version: number; created_at: string }>;
};

export function listWorldsWithVersionSummariesForUser(
  userId: string,
  limit = 50
): WorldWithVersionSummaries[] {
  const worlds = listWorldsForUser(userId, { limit, offset: 0 });
  const out: WorldWithVersionSummaries[] = [];
  for (const w of worlds) {
    const versions = listWorldVersionsForWorld(w.id, userId).map((v) => ({
      id: v.id,
      version: v.version,
      created_at: v.created_at,
    }));
    out.push({ ...w, versions });
  }
  return out;
}

export function getLatestWorldVersion(
  worldId: string,
  userId: string
): WorldVersionRecord | null {
  const versions = listWorldVersionsForWorld(worldId, userId);
  return versions[0] ?? null;
}

/**
 * 世界版本落库后：把 Canonical `character_books[].character_card` upsert 到 `tavern_characters`，
 * 并删除本世界已不在书中的同步行（会解除相关会话的 AI 角色绑定）。
 * 若根对象无 `character_books` 键（旧数据），不改动角色库。
 */
function applyTavernCharacterWorldSync(
  conn: InstanceType<typeof Database>,
  userId: string,
  worldId: string,
  worldVersionId: string,
  canonicalJson: string
): void {
  const specs = extractSyncedCharactersFromCanonical(canonicalJson);
  if (specs === null) {
    return;
  }

  const keys = specs.map((s) => s.stableKey);
  const selExisting = conn.prepare(
    `
    SELECT id FROM tavern_characters
    WHERE user_id = ? AND sync_world_id = ? AND sync_bound_entity_id = ?
    LIMIT 1
  `
  );
  const ins = conn.prepare(
    `
    INSERT INTO tavern_characters (
      id, user_id, name, tags, character_card_json,
      sync_world_id, sync_bound_entity_id, sync_world_version_id
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `
  );
  const upd = conn.prepare(
    `
    UPDATE tavern_characters
    SET name = ?, character_card_json = ?, sync_world_version_id = ?, updated_at = datetime('now')
    WHERE id = ? AND user_id = ?
  `
  );

  const tagSynced = "世界同步";
  for (const s of specs) {
    const row = selExisting.get(userId, worldId, s.stableKey) as
      | { id: string }
      | undefined;
    const name = s.displayName.trim().slice(0, 120) || s.stableKey.slice(0, 120);
    if (row?.id) {
      upd.run(name, s.characterCardJson, worldVersionId, row.id, userId);
    } else {
      ins.run(
        randomUUID(),
        userId,
        name,
        tagSynced,
        s.characterCardJson,
        worldId,
        s.stableKey,
        worldVersionId
      );
    }
  }

  let toRemove: { id: string }[];
  if (keys.length === 0) {
    toRemove = conn
      .prepare(
        `
        SELECT id FROM tavern_characters
        WHERE user_id = ? AND sync_world_id = ?
        AND sync_bound_entity_id IS NOT NULL
      `
      )
      .all(userId, worldId) as { id: string }[];
  } else {
    const ph = keys.map(() => "?").join(", ");
    toRemove = conn
      .prepare(
        `
        SELECT id FROM tavern_characters
        WHERE user_id = ? AND sync_world_id = ?
        AND sync_bound_entity_id IS NOT NULL
        AND sync_bound_entity_id NOT IN (${ph})
      `
      )
      .all(userId, worldId, ...keys) as { id: string }[];
  }

  if (toRemove.length === 0) {
    return;
  }
  const ids = toRemove.map((r) => r.id);
  const idPh = ids.map(() => "?").join(", ");
  conn
    .prepare(
      `
      UPDATE threads
      SET assistant_character_id = NULL, updated_at = datetime('now')
      WHERE user_id = ? AND assistant_character_id IN (${idPh})
    `
    )
    .run(userId, ...ids);
  conn
    .prepare(
      `
      DELETE FROM tavern_characters WHERE user_id = ? AND id IN (${idPh})
    `
    )
    .run(userId, ...ids);
}

export function createWorldVersion(
  worldId: string,
  userId: string,
  input: {
    canonicalJson: string;
    version?: number;
    /** 导入/粘贴的原始文本快照 */
    sourceRawJson?: string | null;
    /** 从某历史版本复制 canonical 时记录来源行 id */
    restoredFromVersionId?: string | null;
  }
): WorldVersionRecord {
  if (!getWorldForUser(worldId, userId)) {
    throw new Error("World is not accessible for this user.");
  }
  if (
    input.version !== undefined &&
    (!Number.isInteger(input.version) || input.version < 1)
  ) {
    throw new Error("Invalid version number.");
  }

  const canonicalJson = input.canonicalJson.trim() || "{}";
  const sourceRaw =
    input.sourceRawJson !== undefined && input.sourceRawJson !== null
      ? input.sourceRawJson
      : null;
  const restoredFrom =
    input.restoredFromVersionId?.trim() || null;

  const conn = getDb();
  const run = conn.transaction((): WorldVersionRecord => {
    let version = input.version;
    if (version === undefined) {
      const row = conn
        .prepare(
          `
        SELECT COALESCE(MAX(version), 0) + 1 AS next_v
        FROM world_versions
        WHERE world_id = ?
      `
        )
        .get(worldId) as { next_v: number };
      version = row.next_v;
    }

    const id = randomUUID();
    try {
      conn
        .prepare(
          `
        INSERT INTO world_versions (id, world_id, version, canonical_json, source_raw_json, restored_from_version_id)
        VALUES (?, ?, ?, ?, ?, ?)
      `
        )
        .run(id, worldId, version, canonicalJson, sourceRaw, restoredFrom);
    } catch {
      throw new Error("Version already exists or insert failed.");
    }

    conn
      .prepare(
        `
      UPDATE worlds
      SET updated_at = datetime('now')
      WHERE id = ?
    `
      )
      .run(worldId);

    applyTavernCharacterWorldSync(conn, userId, worldId, id, canonicalJson);

    const row = conn
      .prepare(
        `
      SELECT id, world_id, version, canonical_json, created_at, source_raw_json, restored_from_version_id
      FROM world_versions
      WHERE id = ?
      LIMIT 1
    `
      )
      .get(id) as WorldVersionRecord | undefined;
    if (!row) throw new Error("Failed to read new world version.");
    return row;
  });

  return run();
}

/**
 * 不创建新版本，仅按某已存在版本的 Canonical 再次执行「世界书 → 角色库」同步。
 * 用于升级后补同步，或让角色库与指定历史版本一致。
 */
export function replayTavernSyncFromWorldVersion(
  worldId: string,
  userId: string,
  worldVersionId: string
): void {
  const bundle = getWorldVersionWithWorldForUser(worldVersionId, userId);
  if (!bundle || bundle.versionRow.world_id !== worldId) {
    throw new Error("版本不存在或无权访问。");
  }
  const conn = getDb();
  conn.transaction(() => {
    applyTavernCharacterWorldSync(
      conn,
      userId,
      worldId,
      worldVersionId,
      bundle.versionRow.canonical_json
    );
  })();
}

/**
 * 将某历史版本的 canonical 复制为**新版本号**（不删除历史，安全「回滚线」）。
 */
export function restoreWorldVersionAsNew(
  worldId: string,
  userId: string,
  fromVersionId: string
): WorldVersionRecord {
  const bundle = getWorldVersionWithWorldForUser(fromVersionId, userId);
  if (!bundle) {
    throw new Error("Source version not found or inaccessible.");
  }
  if (bundle.versionRow.world_id !== worldId) {
    throw new Error("Source version does not belong to this world.");
  }
  return createWorldVersion(worldId, userId, {
    canonicalJson: bundle.versionRow.canonical_json,
    restoredFromVersionId: fromVersionId,
  });
}

/** Phase C：会话事件流（回放、审计、工具调用） */
export type SessionEventRecord = {
  id: string;
  thread_id: string;
  user_id: string;
  event_type: string;
  payload: string;
  created_at: string;
};

export function insertSessionEvent(input: {
  id: string;
  threadId: string;
  userId: string;
  eventType: string;
  payload: Record<string, unknown>;
}): void {
  const conn = getDb();
  const payloadJson = JSON.stringify(input.payload);
  conn
    .prepare(
      `
      INSERT INTO session_event_logs (id, thread_id, user_id, event_type, payload)
      VALUES (?, ?, ?, ?, ?)
    `
    )
    .run(
      input.id,
      input.threadId,
      input.userId,
      input.eventType,
      payloadJson
    );
}

/** 全局洞察层（Insight Layer）：跨会话沉淀条目 */
export type InsightScope = "world" | "user" | "session";

export type InsightRow = {
  id: string;
  summary: string;
  scope: InsightScope;
  created_at: string;
};

export function insertInsight(input: {
  id: string;
  userId: string;
  summary: string;
  scope: InsightScope;
  worldId?: string | null;
  threadId?: string | null;
  metadata?: Record<string, unknown>;
}): void {
  const conn = getDb();
  const meta = JSON.stringify(input.metadata ?? {});
  conn
    .prepare(
      `
      INSERT INTO cw_insights (id, user_id, world_id, thread_id, summary, scope, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `
    )
    .run(
      input.id,
      input.userId,
      input.worldId ?? null,
      input.threadId ?? null,
      input.summary,
      input.scope,
      meta
    );
}

/**
 * 酒馆上下文：用户级 +（可选）世界级 + 本会话级洞察。
 */
export function listInsightsForTavernContext(input: {
  userId: string;
  threadId: string;
  worldId: string | null;
  limit?: number;
}): InsightRow[] {
  const conn = getDb();
  const cap = Math.max(1, Math.min(input.limit ?? 12, 40));
  const wid = input.worldId;
  return conn
    .prepare(
      `
      SELECT id, summary, scope, created_at
      FROM cw_insights
      WHERE user_id = ?
        AND (
          scope = 'user'
          OR (scope = 'world' AND world_id IS NOT NULL AND world_id = ?)
          OR (scope = 'session' AND thread_id = ?)
        )
      ORDER BY created_at DESC, rowid DESC
      LIMIT ?
    `
    )
    .all(input.userId, wid, input.threadId, cap) as InsightRow[];
}

export function listSessionEventsForThread(
  threadId: string,
  userId: string,
  limit = 200
): SessionEventRecord[] {
  const conn = getDb();
  const cap = Math.max(1, Math.min(limit, 500));
  return conn
    .prepare(
      `
      SELECT id, thread_id, user_id, event_type, payload, created_at
      FROM session_event_logs
      WHERE thread_id = ? AND user_id = ?
      ORDER BY created_at ASC, rowid ASC
      LIMIT ?
    `
    )
    .all(threadId, userId, cap) as SessionEventRecord[];
}
