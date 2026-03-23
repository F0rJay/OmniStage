import { cookies } from "next/headers";
import {
  createWorldVersion,
  getLatestWorldVersion,
  getUserModelPreference,
  getWorldForUser,
} from "@/lib/db";
import {
  getApiKeyForProvider,
  isChatMockMode,
  missingKeyMessage,
} from "@/lib/llm";
import { isWorldImportAgentDisabled } from "@/lib/mcp-config";
import {
  invokeWorldForgeUnifiedLangGraphWithProgress,
  WORLD_FORGE_STEP_LABEL,
} from "@/lib/world-forge-langgraph-unified";
import type {
  WorldForgeIncrementTarget,
  WorldForgePipelineResult,
  WorldForgeProfile,
} from "@/lib/world-forge-pipeline-types";
import type { Wf0PipelineResult } from "@/lib/world-forge-wf0";
import { runWorldForgeWf0Pipeline } from "@/lib/world-forge-wf0";
import { runWorldForgeWf1Pipeline } from "@/lib/world-forge-wf1";
import { runWorldForgeWf2Pipeline } from "@/lib/world-forge-wf2";
import { runWorldForgeWf3Pipeline } from "@/lib/world-forge-wf3";
import { shouldPersistWorldForgeAfterSuccess } from "@/lib/world-forge-persist";
import { clampWorldForgeReviewRounds } from "@/lib/world-forge-review-config";
import { wfBuildLatestCanonicalBlock } from "@/lib/world-forge-shared";

export const runtime = "nodejs";
export const maxDuration = 300;

type Params = { params: Promise<{ worldId: string }> };

type Body = {
  profile?: WorldForgeProfile;
  incrementTarget?: WorldForgeIncrementTarget;
  rawBrief?: string;
  mergeWithLatest?: boolean;
  persist?: boolean;
  maxReviewRounds?: number;
  includeLastDraftOnFail?: boolean;
};

function reviewRoundsUsedOf(
  r: WorldForgePipelineResult | Wf0PipelineResult
): number {
  return r.ok && "reviewRoundsUsed" in r ? r.reviewRoundsUsed : 1;
}

export async function POST(request: Request, { params }: Params) {
  const encoder = new TextEncoder();
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();

  const writeLine = async (obj: unknown) => {
    await writer.write(encoder.encode(`${JSON.stringify(obj)}\n`));
  };

  void (async () => {
    try {
      const cookieStore = await cookies();
      const userId = cookieStore.get("cw_user_id")?.value;
      if (!userId) {
        await writeLine({ type: "fatal", error: "Unauthorized.", status: 401 });
        return;
      }

      const { worldId } = await params;
      const world = getWorldForUser(worldId, userId);
      if (!world) {
        await writeLine({ type: "fatal", error: "Not found.", status: 404 });
        return;
      }

      if (isWorldImportAgentDisabled()) {
        await writeLine({
          type: "fatal",
          error:
            "服务端已关闭基于模型的世界书写入（CW_WORLD_IMPORT_AGENT=0）。无法运行 WorldForge。",
          status: 403,
        });
        return;
      }

      let body: Body;
      try {
        body = (await request.json()) as Body;
      } catch {
        await writeLine({ type: "fatal", error: "Invalid JSON body.", status: 400 });
        return;
      }

      const profile = body.profile;
      if (profile !== "wf0" && profile !== "wf1" && profile !== "wf2" && profile !== "wf3") {
        await writeLine({
          type: "fatal",
          error: "body.profile 须为 wf0 | wf1 | wf2 | wf3。",
          status: 400,
        });
        return;
      }
      const incrementTarget = body.incrementTarget ?? "none";
      if (
        incrementTarget !== "none" &&
        incrementTarget !== "character" &&
        incrementTarget !== "location" &&
        incrementTarget !== "organization"
      ) {
        await writeLine({
          type: "fatal",
          error: "body.incrementTarget 须为 none | character | location | organization。",
          status: 400,
        });
        return;
      }

      const rawBrief = body.rawBrief?.trim() ?? "";
      if (!rawBrief) {
        await writeLine({
          type: "fatal",
          error: "rawBrief 必填（大纲或残缺设定文本）。",
          status: 400,
        });
        return;
      }

      const mergeWithLatest = Boolean(body.mergeWithLatest);
      const persistRequested = Boolean(body.persist);
      // 增量补丁（人物/地点/组织）默认应落库，否则用户会看到“生成成功但版本未变化”。
      const persist = persistRequested || incrementTarget !== "none";
      const maxReviewRounds =
        profile === "wf0" ? 1 : clampWorldForgeReviewRounds(body.maxReviewRounds);
      const withLastDraftOnFail = Boolean(body.includeLastDraftOnFail);

      const pref = getUserModelPreference(userId);
      const useMock = isChatMockMode();

      if (!useMock && !getApiKeyForProvider(pref.provider)) {
        await writeLine({
          type: "fatal",
          error: missingKeyMessage(pref.provider),
          status: 503,
        });
        return;
      }

      const latest = getLatestWorldVersion(worldId, userId);
      const hasExistingSavedVersion = latest != null;
      const doPersist = shouldPersistWorldForgeAfterSuccess(
        persist,
        hasExistingSavedVersion
      );
      const currentJson = latest?.canonical_json ?? null;
      const latestBlock = wfBuildLatestCanonicalBlock(
        currentJson,
        mergeWithLatest
      );

      const pipelineCommon = {
        worldName: world.name,
        rawBrief,
        provider: pref.provider,
        modelId: pref.modelId,
        mergeWithLatest,
        currentCanonicalJson: currentJson,
        useMock,
      };

      let result: WorldForgePipelineResult | Wf0PipelineResult;

      if (useMock) {
        if (profile === "wf0") {
          result = await runWorldForgeWf0Pipeline(pipelineCommon);
        } else if (profile === "wf1") {
          result = await runWorldForgeWf1Pipeline({
            ...pipelineCommon,
            maxReviewRounds,
            withLastDraftOnFail,
          });
        } else if (profile === "wf2") {
          result = await runWorldForgeWf2Pipeline({
            ...pipelineCommon,
            maxReviewRounds,
            withLastDraftOnFail,
          });
        } else {
          result = await runWorldForgeWf3Pipeline({
            ...pipelineCommon,
            maxReviewRounds,
            withLastDraftOnFail,
          });
        }
        for (let i = 0; i < result.steps.length; i++) {
          const rec = result.steps[i]!;
          await writeLine({
            type: "progress",
            id: rec.id,
            ok: rec.ok,
            index: i,
            label: WORLD_FORGE_STEP_LABEL[rec.id] ?? rec.id,
          });
        }
      } else {
        result = await invokeWorldForgeUnifiedLangGraphWithProgress(
        {
          profile,
          incrementTarget,
          worldName: world.name,
          brief: rawBrief,
          currentCanonicalJson: currentJson,
          latestBlock,
          maxReviewRounds,
          withLastDraftOnFail,
          mergeWithLatest,
          provider: pref.provider,
          modelId: pref.modelId,
        },
        async (ev) => {
          await writeLine({
            type: "progress",
            id: ev.id,
            ok: ev.ok,
            index: ev.index,
            label: ev.label,
          });
        }
        );
      }

      let version: import("@/lib/db").WorldVersionRecord | null = null;
      if (result.ok && doPersist) {
        try {
          const kind =
            profile === "wf3"
              ? "world_forge_wf3_graph_parallel"
              : profile === "wf2"
                ? "world_forge_wf2_parallel"
                : profile === "wf1"
                  ? "world_forge_wf1"
                  : "world_forge_wf0";
          version = createWorldVersion(worldId, userId, {
            canonicalJson: result.normalizedJson,
            sourceRawJson: JSON.stringify({
              kind,
              worldId,
              mergeWithLatest,
              stream: true,
              reviewRoundsUsed: reviewRoundsUsedOf(result),
              stepCount: result.steps.length,
              graphBlueprint:
                profile === "wf3" && "graphBlueprint" in result
                  ? result.graphBlueprint
                  : undefined,
              persistRequested: persist,
              incrementTarget,
              autoFirstVersion: doPersist && !persist,
              reviewWarnings:
                "reviewWarnings" in result ? result.reviewWarnings : undefined,
              at: new Date().toISOString(),
            }),
          });
        } catch (e) {
          await writeLine({
            type: "result",
            ok: true,
            profile,
            persisted: false,
            persistError:
              e instanceof Error ? e.message : "保存版本失败。",
            steps: result.steps,
            mock: result.mock,
            normalizedJson: result.normalizedJson,
            graphBlueprint:
              profile === "wf3" && "graphBlueprint" in result
                ? result.graphBlueprint
                : undefined,
            reviewRoundsUsed: reviewRoundsUsedOf(result),
            reviewWarnings:
              "reviewWarnings" in result ? result.reviewWarnings : undefined,
            autoPersistFirstVersion: false,
          });
          return;
        }
      }

      await writeLine({
        type: "result",
        ok: result.ok,
        profile,
        ...(result.ok
          ? {
              persisted: Boolean(version),
              version,
              versionsUrl: version
                ? `/worlds/${worldId}/versions`
                : undefined,
              steps: result.steps,
              mock: result.mock,
              normalizedJson: result.normalizedJson,
              graphBlueprint:
                profile === "wf3" && "graphBlueprint" in result
                  ? result.graphBlueprint
                  : undefined,
              reviewRoundsUsed: reviewRoundsUsedOf(result),
              reviewWarnings:
                result.ok && "reviewWarnings" in result
                  ? result.reviewWarnings
                  : undefined,
              autoPersistFirstVersion:
                Boolean(version) && !persist && !hasExistingSavedVersion,
              incrementTarget,
            }
          : {
              steps: result.steps,
              error: result.error,
              errors: result.errors,
              mock: result.mock,
              lastReviewIssues:
                "lastReviewIssues" in result
                  ? result.lastReviewIssues
                  : undefined,
              lastNormalizedJson:
                "lastNormalizedJson" in result
                  ? result.lastNormalizedJson
                  : undefined,
            }),
      });
    } catch (e) {
      await writeLine({
        type: "fatal",
        error: e instanceof Error ? e.message : String(e),
        status: 500,
      });
    } finally {
      await writer.close();
    }
  })();

  return new Response(readable, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
