import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import ModelPreferencePanel from "./model-preference-panel";
import { getUserModelPreference } from "@/lib/db";
import { MODEL_OPTIONS } from "@/lib/models";

export default async function ProfilePage() {
  const cookieStore = await cookies();
  const userId = cookieStore.get("cw_user_id")?.value;
  if (!userId) {
    redirect("/sign-in");
  }

  const preference = getUserModelPreference(userId);

  return (
    <main className="page-shell">
      <div className="panel">
        <h1 style={{ marginTop: 0 }}>个人偏好</h1>
        <p className="muted">设置<strong>默认模型</strong>：之后新建的会话会沿用此处选择（单局内仍可更换）。</p>
        <Link className="button" href="/tavern">
          返回酒馆
        </Link>
      </div>
      <ModelPreferencePanel initialModel={preference} modelOptions={MODEL_OPTIONS} />
    </main>
  );
}
