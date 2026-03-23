import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import {
  createUserModelEndpoint,
  deleteUserModelEndpoint,
  listUserModelEndpoints,
} from "@/lib/db";

type CreateBody = {
  name?: string;
  baseUrl?: string;
  apiKey?: string;
  modelId?: string;
};

export async function GET() {
  const cookieStore = await cookies();
  const userId = cookieStore.get("cw_user_id")?.value;
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  const items = listUserModelEndpoints(userId).map((x) => ({
    id: x.id,
    name: x.name,
    providerType: x.provider_type,
    baseUrl: x.base_url,
    modelId: x.model_id,
    createdAt: x.created_at,
    updatedAt: x.updated_at,
  }));
  return NextResponse.json({ items });
}

export async function POST(request: Request) {
  const cookieStore = await cookies();
  const userId = cookieStore.get("cw_user_id")?.value;
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  let body: CreateBody;
  try {
    body = (await request.json()) as CreateBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const name = body.name?.trim() ?? "";
  const baseUrl = body.baseUrl?.trim() ?? "";
  const apiKey = body.apiKey?.trim() ?? "";
  const modelId = body.modelId?.trim() ?? "";
  if (!name || !baseUrl || !apiKey || !modelId) {
    return NextResponse.json(
      { error: "name, baseUrl, apiKey, modelId are required." },
      { status: 400 }
    );
  }
  try {
    const u = new URL(baseUrl);
    if (!/^https?:$/.test(u.protocol)) throw new Error("bad protocol");
  } catch {
    return NextResponse.json({ error: "baseUrl must be a valid http(s) URL." }, { status: 400 });
  }
  const created = createUserModelEndpoint(userId, {
    name,
    baseUrl,
    apiKey,
    modelId,
  });
  return NextResponse.json({
    ok: true,
    item: {
      id: created.id,
      name: created.name,
      providerType: created.provider_type,
      baseUrl: created.base_url,
      modelId: created.model_id,
      createdAt: created.created_at,
      updatedAt: created.updated_at,
    },
  });
}

export async function DELETE(request: Request) {
  const cookieStore = await cookies();
  const userId = cookieStore.get("cw_user_id")?.value;
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  const url = new URL(request.url);
  const endpointId = url.searchParams.get("id")?.trim() ?? "";
  if (!endpointId) {
    return NextResponse.json({ error: "id is required." }, { status: 400 });
  }
  deleteUserModelEndpoint(userId, endpointId);
  return NextResponse.json({ ok: true });
}

