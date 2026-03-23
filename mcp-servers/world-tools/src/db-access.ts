import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

const MAX_CANONICAL_RETURN_CHARS = 120_000;

export function requireContext(): { dbPath: string; userId: string } {
  const dbPath = process.env.CANONWEAVE_DB_PATH?.trim();
  const userId = process.env.CANONWEAVE_MCP_USER_ID?.trim();
  if (!dbPath || !userId) {
    throw new Error(
      "Missing CANONWEAVE_DB_PATH or CANONWEAVE_MCP_USER_ID (host must set when spawning MCP)."
    );
  }
  return { dbPath, userId };
}

export function listWorlds(db: Database.Database, userId: string, limit = 50) {
  return db
    .prepare(
      `
      SELECT id, name, description, created_at, updated_at
      FROM worlds
      WHERE user_id = ?
      ORDER BY updated_at DESC, created_at DESC
      LIMIT ?
    `
    )
    .all(userId, limit) as Array<{
    id: string;
    name: string;
    description: string;
    created_at: string;
    updated_at: string;
  }>;
}

export function getWorld(db: Database.Database, worldId: string, userId: string) {
  return db
    .prepare(
      `
      SELECT id, user_id, name, description, created_at, updated_at
      FROM worlds
      WHERE id = ? AND user_id = ?
      LIMIT 1
    `
    )
    .get(worldId, userId) as
    | {
        id: string;
        user_id: string;
        name: string;
        description: string;
        created_at: string;
        updated_at: string;
      }
    | undefined;
}

export function listVersions(db: Database.Database, worldId: string, userId: string) {
  if (!getWorld(db, worldId, userId)) {
    throw new Error("World not found or inaccessible for this user.");
  }
  return db
    .prepare(
      `
      SELECT id, world_id, version, created_at
      FROM world_versions
      WHERE world_id = ?
      ORDER BY version DESC, created_at DESC
    `
    )
    .all(worldId) as Array<{
    id: string;
    world_id: string;
    version: number;
    created_at: string;
  }>;
}

export function getCanonicalByWorldAndVersion(
  db: Database.Database,
  worldId: string,
  userId: string,
  versionNum?: number
): {
  version_id: string;
  version: number;
  canonical_json: string;
  truncated: boolean;
  created_at: string;
} {
  if (!getWorld(db, worldId, userId)) {
    throw new Error("World not found or inaccessible for this user.");
  }

  const row =
    versionNum === undefined
      ? (db
          .prepare(
            `
          SELECT wv.id AS vid, wv.version AS vnum, wv.canonical_json AS cj, wv.created_at AS vca
          FROM world_versions wv
          INNER JOIN worlds w ON w.id = wv.world_id
          WHERE wv.world_id = ? AND w.user_id = ?
          ORDER BY wv.version DESC, wv.created_at DESC
          LIMIT 1
        `
          )
          .get(worldId, userId) as
          | { vid: string; vnum: number; cj: string; vca: string }
          | undefined)
      : (db
          .prepare(
            `
          SELECT wv.id AS vid, wv.version AS vnum, wv.canonical_json AS cj, wv.created_at AS vca
          FROM world_versions wv
          INNER JOIN worlds w ON w.id = wv.world_id
          WHERE wv.world_id = ? AND w.user_id = ? AND wv.version = ?
          LIMIT 1
        `
          )
          .get(worldId, userId, versionNum) as
          | { vid: string; vnum: number; cj: string; vca: string }
          | undefined);

  if (!row) {
    throw new Error(
      versionNum === undefined
        ? "No world versions found."
        : `Version ${versionNum} not found.`
    );
  }

  let json = row.cj;
  let truncated = false;
  if (json.length > MAX_CANONICAL_RETURN_CHARS) {
    json = json.slice(0, MAX_CANONICAL_RETURN_CHARS);
    truncated = true;
  }

  return {
    version_id: row.vid,
    version: row.vnum,
    canonical_json: json,
    truncated,
    created_at: row.vca,
  };
}

export function getCanonicalByVersionId(
  db: Database.Database,
  versionId: string,
  userId: string
) {
  const row = db
    .prepare(
      `
      SELECT wv.id AS vid, wv.world_id AS wvid, wv.version AS vnum, wv.canonical_json AS cj, wv.created_at AS vca
      FROM world_versions wv
      INNER JOIN worlds w ON w.id = wv.world_id
      WHERE wv.id = ? AND w.user_id = ?
      LIMIT 1
    `
    )
    .get(versionId, userId) as
    | { vid: string; wvid: string; vnum: number; cj: string; vca: string }
    | undefined;

  if (!row) {
    throw new Error("World version not found or inaccessible for this user.");
  }

  let json = row.cj;
  let truncated = false;
  if (json.length > MAX_CANONICAL_RETURN_CHARS) {
    json = json.slice(0, MAX_CANONICAL_RETURN_CHARS);
    truncated = true;
  }

  return {
    version_id: row.vid,
    world_id: row.wvid,
    version: row.vnum,
    canonical_json: json,
    truncated,
    created_at: row.vca,
  };
}

export function appendWorldVersion(
  db: Database.Database,
  worldId: string,
  userId: string,
  canonicalJson: string,
  sourceRawJson: string | null
): { version_id: string; version: number } {
  if (!getWorld(db, worldId, userId)) {
    throw new Error("World not found or inaccessible for this user.");
  }

  const nextRow = db
    .prepare(
      `
      SELECT COALESCE(MAX(version), 0) + 1 AS next_v
      FROM world_versions
      WHERE world_id = ?
    `
    )
    .get(worldId) as { next_v: number };
  const version = nextRow.next_v;

  const id = randomUUID();

  db.prepare(
    `
    INSERT INTO world_versions (id, world_id, version, canonical_json, source_raw_json, restored_from_version_id)
    VALUES (?, ?, ?, ?, ?, NULL)
  `
  ).run(id, worldId, version, canonicalJson, sourceRawJson);

  db.prepare(
    `
    UPDATE worlds SET updated_at = datetime('now') WHERE id = ?
  `
  ).run(worldId);

  return { version_id: id, version };
}

export function createWorldRow(
  db: Database.Database,
  userId: string,
  name: string,
  description: string
): { world_id: string } {
  const id = randomUUID();
  const n = name.trim().slice(0, 120);
  const d = description.trim().slice(0, 2000);
  if (!n) {
    throw new Error("World name is required.");
  }
  db.prepare(
    `
    INSERT INTO worlds (id, user_id, name, description)
    VALUES (?, ?, ?, ?)
  `
  ).run(id, userId, n, d);
  return { world_id: id };
}
