import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { DEFAULT_MODEL, MODEL_OPTIONS } from "@/lib/models";
import { listUserModelEndpoints } from "@/lib/db";

export async function GET() {
  const cookieStore = await cookies();
  const userId = cookieStore.get("cw_user_id")?.value;
  const custom = userId
    ? listUserModelEndpoints(userId).map((ep) => ({
        provider: `custom_openai::${ep.id}`,
        modelId: ep.model_id,
        label: `${ep.name}（自定义）`,
        tier: "balanced" as const,
      }))
    : [];
  return NextResponse.json({
    default: DEFAULT_MODEL,
    models: [...custom, ...MODEL_OPTIONS],
  });
}
