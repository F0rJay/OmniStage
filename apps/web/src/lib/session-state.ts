/** 会话运行时状态（掷骰、后续工具等写入 threads.session_state_json） */

const MAX_KEYS = 80;
const MAX_KEY_LEN = 128;
const MAX_STATE_JSON_IN_PROMPT = 6000;

export function sanitizeSessionStatePatch(
  patch: unknown
): Record<string, unknown> {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    return {};
  }
  const raw = patch as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  let n = 0;
  for (const [k, v] of Object.entries(raw)) {
    if (n++ >= MAX_KEYS) break;
    if (k === "__proto__" || k === "constructor" || k.length > MAX_KEY_LEN) {
      continue;
    }
    try {
      JSON.stringify(v);
      out[k] = v;
    } catch {
      /* skip non-serializable */
    }
  }
  return out;
}

export function parseThreadSessionStateJson(raw: string | null | undefined): Record<string, unknown> {
  try {
    const o = JSON.parse(raw || "{}");
    return typeof o === "object" && o !== null && !Array.isArray(o)
      ? (o as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function formatSessionStateForPrompt(
  state: Record<string, unknown>
): string | null {
  const keys = Object.keys(state);
  if (keys.length === 0) return null;
  let s = JSON.stringify(state);
  if (s.length > MAX_STATE_JSON_IN_PROMPT) {
    s = s.slice(0, MAX_STATE_JSON_IN_PROMPT) + "…[截断]";
  }
  return (
    "【会话状态（可由掷骰或 PATCH 更新；叙事可参考但不要编造未出现的数值）】\n" +
    s
  );
}
