/**
 * CanonWeave MCP：world_reader + world_writer（stdio）。
 * 鉴权：仅信任环境变量 CANONWEAVE_MCP_USER_ID，工具参数中不得传 user_id。
 */
import Database from "better-sqlite3";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod";
import { parseAndValidateCanonicalWorld } from "./canonical-world.js";
import {
  appendWorldVersion,
  createWorldRow,
  getCanonicalByVersionId,
  getCanonicalByWorldAndVersion,
  getWorld,
  listVersions,
  listWorlds,
  requireContext,
} from "./db-access.js";

function okJson(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
  };
}

function errJson(message: string) {
  return {
    isError: true as const,
    content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }],
  };
}

const ReaderInputSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("list_worlds") }),
  z.object({
    operation: z.literal("get_summary"),
    world_id: z.string().uuid(),
  }),
  z.object({
    operation: z.literal("list_versions"),
    world_id: z.string().uuid(),
  }),
  z.object({
    operation: z.literal("get_canonical"),
    world_id: z.string().uuid(),
    version: z.coerce.number().int().positive().optional(),
  }),
  z.object({
    operation: z.literal("get_canonical_by_version_id"),
    version_id: z.string().uuid(),
  }),
]);

const WriterInputSchema = z.discriminatedUnion("operation", [
  z.object({
    operation: z.literal("append_version"),
    world_id: z.string().uuid(),
    canonical_json: z.string().min(1).max(600_000),
    source_note: z.string().max(2000).optional(),
    citations_json: z.string().max(200_000).optional(),
  }),
  z.object({
    operation: z.literal("create_world"),
    name: z.string().min(1).max(120),
    description: z.string().max(2000).optional(),
  }),
]);

function openDb(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma("foreign_keys = ON");
  return db;
}

const server = new McpServer(
  { name: "canonweave-world-tools", version: "0.1.0" },
  {
    instructions:
      "CanonWeave world_reader / world_writer. Host MUST set CANONWEAVE_DB_PATH (sqlite) and CANONWEAVE_MCP_USER_ID. Never put user_id in tool arguments.",
  }
);

server.registerTool(
  "world_reader",
  {
    description:
      "Read worlds and canonical JSON. Operations: list_worlds | get_summary | list_versions | get_canonical | get_canonical_by_version_id.",
    inputSchema: ReaderInputSchema,
  },
  async (input) => {
    try {
      const { dbPath, userId } = requireContext();
      const db = openDb(dbPath);
      try {
        switch (input.operation) {
          case "list_worlds": {
            const worlds = listWorlds(db, userId, 50);
            return okJson({ worlds });
          }
          case "get_summary": {
            const w = getWorld(db, input.world_id, userId);
            if (!w) return errJson("World not found or inaccessible.");
            const versions = listVersions(db, input.world_id, userId);
            return okJson({
              world: {
                id: w.id,
                name: w.name,
                description: w.description,
                created_at: w.created_at,
                updated_at: w.updated_at,
              },
              version_count: versions.length,
              latest_version: versions[0]?.version ?? null,
            });
          }
          case "list_versions": {
            const versions = listVersions(db, input.world_id, userId);
            return okJson({ versions });
          }
          case "get_canonical": {
            const data = getCanonicalByWorldAndVersion(
              db,
              input.world_id,
              userId,
              input.version
            );
            return okJson(data);
          }
          case "get_canonical_by_version_id": {
            const data = getCanonicalByVersionId(db, input.version_id, userId);
            return okJson(data);
          }
          default:
            return errJson("Unsupported operation");
        }
      } finally {
        db.close();
      }
    } catch (e) {
      return errJson(e instanceof Error ? e.message : String(e));
    }
  }
);

server.registerTool(
  "world_writer",
  {
    description:
      "append_version: new world_versions row (validated canonical). create_world: new empty world shell. Optional source_note + citations_json → source_raw_json audit.",
    inputSchema: WriterInputSchema,
  },
  async (input) => {
    try {
      const { dbPath, userId } = requireContext();
      const db = openDb(dbPath);
      try {
        if (input.operation === "create_world") {
          const { world_id } = createWorldRow(
            db,
            userId,
            input.name,
            input.description ?? ""
          );
          return okJson({ world_id, operation: "create_world" });
        }

        const validated = parseAndValidateCanonicalWorld(input.canonical_json);
        if (!validated.ok) {
          return errJson(`Canonical validation failed: ${validated.errors.join("; ")}`);
        }

        let sourceRaw: string | null = null;
        if (input.source_note || input.citations_json) {
          let citations: unknown = null;
          if (input.citations_json) {
            try {
              citations = JSON.parse(input.citations_json) as unknown;
            } catch {
              return errJson("citations_json must be valid JSON.");
            }
          }
          sourceRaw = JSON.stringify({
            provenance: "mcp_world_writer",
            note: input.source_note ?? null,
            citations,
          });
        }

        const { version_id, version } = appendWorldVersion(
          db,
          input.world_id,
          userId,
          validated.normalizedJson,
          sourceRaw
        );

        return okJson({
          operation: "append_version",
          world_id: input.world_id,
          version_id,
          version,
        });
      } finally {
        db.close();
      }
    } catch (e) {
      return errJson(e instanceof Error ? e.message : String(e));
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
