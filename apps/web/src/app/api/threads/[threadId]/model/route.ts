import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import {
  ensureThread,
  getUserModelEndpointForUser,
  updateThreadModel,
} from "@/lib/db";
import { MODEL_OPTIONS } from "@/lib/models";

type Params = { params: Promise<{ threadId: string }> };

type RequestBody = {
  provider?: string;
  modelId?: string;
};

export async function PUT(request: Request, { params }: Params) {
  const cookieStore = await cookies();
  const userId = cookieStore.get("cw_user_id")?.value;
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const { threadId } = await params;
  let body: RequestBody;
  try {
    body = (await request.json()) as RequestBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const provider = body.provider?.trim();
  const modelId = body.modelId?.trim();
  if (!provider || !modelId) {
    return NextResponse.json(
      { error: "provider and modelId are required." },
      { status: 400 }
    );
  }

  const isBuiltin = MODEL_OPTIONS.some(
    (item) => item.provider === provider && item.modelId === modelId
  );
  const isCustom = provider.startsWith("custom_openai::");
  if (!isBuiltin && !isCustom) {
    return NextResponse.json({ error: "Unsupported model selection." }, { status: 400 });
  }
  if (isCustom) {
    const endpointId = provider.slice("custom_openai::".length).trim();
    const endpoint = endpointId
      ? getUserModelEndpointForUser(userId, endpointId)
      : null;
    if (!endpoint) {
      return NextResponse.json({ error: "Custom endpoint not found." }, { status: 400 });
    }
  }

  try {
    ensureThread(threadId, userId);
    updateThreadModel(threadId, userId, { provider, modelId });
  } catch {
    return NextResponse.json({ error: "Forbidden thread access." }, { status: 403 });
  }

  return NextResponse.json({
    ok: true,
    selected: { provider, modelId },
  });
}
