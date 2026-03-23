import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import {
  parseAndValidateCanonicalWorld,
  type ValidateResult,
} from "@/lib/canonical-world";
import {
  createWorld,
  createWorldVersion,
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
  defaultWorldNameFromFileName,
  prepareRawTextForImport,
} from "@/lib/world-import-file";
import {
  convertWorldSourceWithAgent,
  enrichCharacterBooksWithAgent,
} from "@/lib/world-import-agent";

export const maxDuration = 120;

type JsonBody = {
  rawJson?: string;
  fileName?: string;
  worldId?: string;
  worldName?: string;
  worldDescription?: string;
  useAgent?: boolean;
  modelProvider?: string;
  modelId?: string;
  autoEnrichCharacterBooks?: boolean;
};

function formGetString(form: FormData, key: string): string | undefined {
  const v = form.get(key);
  return typeof v === "string" ? v : undefined;
}

function buildSourceSnapshot(input: {
  useAgent: boolean;
  rawJson: string;
  fileName: string | null;
  modelProvider: string;
  modelId: string;
}): string {
  if (input.useAgent) {
    return JSON.stringify({
      kind: "agent_import",
      fileName: input.fileName,
      rawText: input.rawJson,
      modelProvider: input.modelProvider,
      modelId: input.modelId,
      at: new Date().toISOString(),
    });
  }
  if (input.fileName) {
    return JSON.stringify({
      kind: "file_import",
      fileName: input.fileName,
      rawText: input.rawJson,
      at: new Date().toISOString(),
    });
  }
  return input.rawJson;
}

export async function POST(request: Request) {
  const cookieStore = await cookies();
  const userId = cookieStore.get("cw_user_id")?.value;
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const contentType = request.headers.get("content-type") ?? "";
  let rawText: string;
  let fileName: string | null = null;
  let worldId: string | undefined;
  let worldName: string | undefined;
  let worldDescription: string | undefined;
  let useAgent = false;
  let modelProvider: string | undefined;
  let modelId: string | undefined;
  let autoEnrichCharacterBooks = false;

  if (contentType.includes("multipart/form-data")) {
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      return NextResponse.json({ error: "Invalid multipart body." }, { status: 400 });
    }

    const file = form.get("file");
    if (!(file instanceof Blob)) {
      return NextResponse.json(
        { error: "请上传世界书文件（表单字段 file）。" },
        { status: 400 }
      );
    }

    rawText = await file.text();
    fileName = file instanceof File && file.name ? file.name : "worldbook";

    useAgent = formGetString(form, "useAgent") === "true";
    worldId = formGetString(form, "worldId")?.trim() || undefined;
    worldName = formGetString(form, "worldName")?.trim() || undefined;
    worldDescription = formGetString(form, "worldDescription")?.trim() || undefined;
    modelProvider = formGetString(form, "modelProvider")?.trim() || undefined;
    modelId = formGetString(form, "modelId")?.trim() || undefined;
    autoEnrichCharacterBooks = formGetString(form, "autoEnrichCharacterBooks") === "true";

    if (!worldName && !worldId) {
      worldName = defaultWorldNameFromFileName(fileName);
    }
  } else if (contentType.includes("application/json")) {
    let body: JsonBody;
    try {
      body = (await request.json()) as JsonBody;
    } catch {
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
    }

    if (typeof body.rawJson !== "string" || !body.rawJson.trim()) {
      return NextResponse.json(
        { error: "rawJson is required（或改用 multipart 上传 file）。" },
        { status: 400 }
      );
    }

    rawText = body.rawJson;
    fileName = body.fileName?.trim() || null;
    useAgent = Boolean(body.useAgent);
    worldId = body.worldId?.trim() || undefined;
    worldName = body.worldName?.trim() || undefined;
    worldDescription = body.worldDescription?.trim() || undefined;
    modelProvider = body.modelProvider?.trim() || undefined;
    modelId = body.modelId?.trim() || undefined;
    autoEnrichCharacterBooks = Boolean(body.autoEnrichCharacterBooks);
  } else {
    return NextResponse.json(
      {
        error:
          "请使用 multipart/form-data 上传文件，或 application/json 传入 rawJson（高级）。",
      },
      { status: 415 }
    );
  }

  if (!rawText.trim()) {
    return NextResponse.json({ error: "文件内容为空。" }, { status: 400 });
  }

  const userModelPref = getUserModelPreference(userId);
  const effectiveFileName = fileName ?? "pasted.txt";

  const prepared = prepareRawTextForImport({
    rawText,
    fileName: effectiveFileName,
    useAgent,
  });
  if (!prepared.ok) {
    return NextResponse.json({ error: prepared.error }, { status: 400 });
  }

  const rawJson = prepared.rawJson;

  let validated: ValidateResult;

  if (useAgent) {
    if (isChatMockMode()) {
      return NextResponse.json(
        {
          error:
            "CW_CHAT_MOCK=1 时不能使用 AI 解析。请关闭 Mock 并配置真实模型 Key。",
        },
        { status: 503 }
      );
    }
    if (isWorldImportAgentDisabled()) {
      return NextResponse.json(
        {
          error:
            "服务端已关闭世界书 AI 解析（CW_WORLD_IMPORT_AGENT=0）。请改用规则路径（JSON/YAML）。",
        },
        { status: 403 }
      );
    }

    const provider = modelProvider || userModelPref.provider;
    const mid = modelId || userModelPref.modelId;

    if (!getApiKeyForProvider(provider)) {
      return NextResponse.json(
        { error: missingKeyMessage(provider) },
        { status: 503 }
      );
    }

    const agentResult = await convertWorldSourceWithAgent({
      rawText: rawJson,
      provider,
      modelId: mid,
    });

    if (!agentResult.ok) {
      return NextResponse.json(
        {
          error: agentResult.error,
          errors: agentResult.errors,
          agentUsed: true,
          fileName,
        },
        { status: 422 }
      );
    }

    validated = agentResult.validated;

    if (autoEnrichCharacterBooks) {
      const enrichResult = await enrichCharacterBooksWithAgent({
        canonicalJson: validated.normalizedJson,
        provider,
        modelId: mid,
      });
      if (!enrichResult.ok) {
        return NextResponse.json(
          {
            error: `角色卡补齐失败：${enrichResult.error}`,
            errors: enrichResult.errors,
            agentUsed: true,
            fileName,
          },
          { status: 422 }
        );
      }
      validated = enrichResult.validated;
    }
  } else {
    validated = parseAndValidateCanonicalWorld(rawJson);
    if (!validated.ok) {
      return NextResponse.json(
        {
          error: "Validation failed.",
          errors: validated.errors,
          fileName,
        },
        { status: 422 }
      );
    }
  }

  let wid = worldId?.trim();
  let world;

  if (wid) {
    world = getWorldForUser(wid, userId);
    if (!world) {
      return NextResponse.json({ error: "World not found." }, { status: 404 });
    }
  } else {
    const name = worldName?.trim() || "Imported world";
    try {
      world = createWorld(userId, {
        name,
        description: worldDescription,
      });
      wid = world.id;
    } catch (e) {
      const message = e instanceof Error ? e.message : "Create world failed.";
      return NextResponse.json({ error: message }, { status: 400 });
    }
  }

  if (!wid) {
    return NextResponse.json({ error: "Internal error." }, { status: 500 });
  }

  const sourceSnapshot = buildSourceSnapshot({
    useAgent,
    rawJson: rawText,
    fileName,
    modelProvider: modelProvider || userModelPref.provider,
    modelId: modelId || userModelPref.modelId,
  });

  try {
    const version = createWorldVersion(wid, userId, {
      canonicalJson: validated.normalizedJson,
      sourceRawJson: sourceSnapshot,
    });
    return NextResponse.json(
      {
        ok: true,
        world,
        version,
        versionsUrl: `/worlds/${wid}/versions`,
        agentUsed: useAgent,
        fileName,
      },
      { status: 201 }
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : "Version create failed.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
