import { cookies } from "next/headers";
import { NextResponse } from "next/server";
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
import { shouldPersistWorldForgeAfterSuccess } from "@/lib/world-forge-persist";
import { runWorldForgeWf2Pipeline } from "@/lib/world-forge-wf2";

export const runtime = "nodejs";
export const maxDuration = 300;

type Params = { params: Promise<{ worldId: string }> };

type Body = {
  rawBrief?: string;
  mergeWithLatest?: boolean;
  persist?: boolean;
  maxReviewRounds?: number;
  includeLastDraftOnFail?: boolean;
};

export async function POST(request: Request, { params }: Params) {
  try {
  const cookieStore = await cookies();
  const userId = cookieStore.get("cw_user_id")?.value;
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const { worldId } = await params;
  const world = getWorldForUser(worldId, userId);
  if (!world) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  if (isWorldImportAgentDisabled()) {
    return NextResponse.json(
      {
        error:
          "服务端已关闭基于模型的世界书写入（CW_WORLD_IMPORT_AGENT=0）。无法运行 WorldForge。",
      },
      { status: 403 }
    );
  }

  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const rawBrief = body.rawBrief?.trim() ?? "";
  if (!rawBrief) {
    return NextResponse.json(
      { error: "rawBrief 必填（大纲或残缺设定文本）。" },
      { status: 400 }
    );
  }

  const mergeWithLatest = Boolean(body.mergeWithLatest);
  const persist = Boolean(body.persist);
  const maxReviewRounds = body.maxReviewRounds;
  const withLastDraftOnFail = Boolean(body.includeLastDraftOnFail);

  const pref = getUserModelPreference(userId);
  const useMock = isChatMockMode();

  if (!useMock && !getApiKeyForProvider(pref.provider)) {
    return NextResponse.json(
      { error: missingKeyMessage(pref.provider) },
      { status: 503 }
    );
  }

  const latest = getLatestWorldVersion(worldId, userId);
  const hasExistingSavedVersion = latest != null;
  const currentJson = latest?.canonical_json ?? null;
  const doPersist = shouldPersistWorldForgeAfterSuccess(
    persist,
    hasExistingSavedVersion
  );

  const result = await runWorldForgeWf2Pipeline({
    worldName: world.name,
    rawBrief,
    provider: pref.provider,
    modelId: pref.modelId,
    mergeWithLatest,
    currentCanonicalJson: currentJson,
    useMock,
    maxReviewRounds,
    withLastDraftOnFail,
  });

  if (!result.ok) {
    return NextResponse.json(
      {
        ok: false,
        profile: result.profile,
        steps: result.steps,
        error: result.error,
        errors: result.errors,
        mock: result.mock,
        lastReviewIssues: result.lastReviewIssues,
        lastNormalizedJson: result.lastNormalizedJson,
      },
      { status: 422 }
    );
  }

  let version = null;
  if (doPersist) {
    try {
      version = createWorldVersion(worldId, userId, {
        canonicalJson: result.normalizedJson,
        sourceRawJson: JSON.stringify({
          kind: "world_forge_wf2_parallel",
          worldId,
          mergeWithLatest,
          mock: useMock,
          reviewRoundsUsed: result.reviewRoundsUsed,
          stepCount: result.steps.length,
          persistRequested: persist,
          autoFirstVersion: doPersist && !persist,
          reviewWarnings: result.reviewWarnings,
          at: new Date().toISOString(),
        }),
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : "保存版本失败。";
      return NextResponse.json(
        {
          ok: true,
          profile: result.profile,
          persisted: false,
          persistError: message,
          steps: result.steps,
          mock: result.mock,
          normalizedJson: result.normalizedJson,
          reviewRoundsUsed: result.reviewRoundsUsed,
          reviewWarnings: result.reviewWarnings,
        },
        { status: 200 }
      );
    }
  }

  return NextResponse.json({
    ok: true,
    profile: result.profile,
    persisted: Boolean(version),
    version,
    versionsUrl: version ? `/worlds/${worldId}/versions` : undefined,
    steps: result.steps,
    mock: result.mock,
    normalizedJson: result.normalizedJson,
    reviewRoundsUsed: result.reviewRoundsUsed,
    reviewWarnings: result.reviewWarnings,
    autoPersistFirstVersion:
      Boolean(version) && !persist && !hasExistingSavedVersion,
  });
  } catch (e) {
    console.error("[api world-forge/wf2]", e);
    return NextResponse.json(
      {
        ok: false,
        error:
          e instanceof Error
            ? e.message
            : "服务器内部错误，请查看运行 Next 的终端日志。",
      },
      { status: 500 }
    );
  }
}
