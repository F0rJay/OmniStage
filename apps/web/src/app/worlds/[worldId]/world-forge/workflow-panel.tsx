"use client";

import Link from "next/link";
import { FormEvent, useState } from "react";
import {
  WORLD_FORGE_DEFAULT_MAX_REVIEW_ROUNDS,
  WORLD_FORGE_MAX_REVIEW_ROUNDS_CAP,
} from "@/lib/world-forge-review-config";

/** 后端 profile；UI 上不强调「档位切换」，仅作缩短路径时的技术路由 */
type Profile = "wf0" | "wf1" | "wf2" | "wf3";
type IncrementTarget = "none" | "character" | "location" | "organization";

const SHORT_PATH_OPTIONS: {
  value: Profile;
  label: string;
  hint: string;
}[] = [
  {
    value: "wf3",
    label: "完整创作（推荐）",
    hint: "内容更完整，细节更丰富，耗时略长",
  },
  {
    value: "wf2",
    label: "快速创作",
    hint: "速度更快，适合快速试稿",
  },
  {
    value: "wf1",
    label: "简化创作",
    hint: "适合小改动或补充少量设定",
  },
  {
    value: "wf0",
    label: "极速草稿",
    hint: "最快出稿，适合灵感预览",
  },
];

type ProgressRow = {
  key: string;
  label: string;
  ok: boolean;
};

function buildAddCharactersPrompt(count: number): string {
  const n = Math.max(1, Math.min(count, 5));
  return (
    `基于当前世界版本做增量，不要删除现有角色与设定。\n` +
    `请新增 ${n} 个可扮演角色，加入 character_books，并与 entities 建立绑定。\n\n` +
    `硬性要求：\n` +
    `1) 本轮是“增量补充”，保留已有 world_book / character_books / entities / rules / timeline。\n` +
    `2) 最终 character_books 总数 >= ${Math.max(3, n + 1)}。\n` +
    `3) 每个新角色必须包含：\n` +
    `   - bound_entity_id（英文 slug，唯一）\n` +
    `   - bound_entity_name（中文名）\n` +
    `   - name（人物书名）\n` +
    `   - 完整 character_card（description、personality、scenario、first_mes、mes_example）\n` +
    `   - entries 3~6 条（含 keys[]、strategy）\n` +
    `4) 新角色需与现有主线建立可互动关系（每人至少 2 条冲突/合作钩子）。\n` +
    `5) 不要破坏既有 locks 与核心时间线；只输出合法 Canonical JSON。`
  );
}

type ForgeApiPayload = {
  ok?: boolean;
  profile?: string;
  error?: string;
  errors?: string[];
  steps?: unknown[];
  normalizedJson?: string;
  lastNormalizedJson?: string;
  lastReviewIssues?: string[];
  /** 成功但审查用尽轮次时采纳当前稿的残余意见 */
  reviewWarnings?: string[];
  persisted?: boolean;
  version?: { version: number };
  persistError?: string;
  mock?: boolean;
  reviewRoundsUsed?: number;
  graphBlueprint?: unknown;
  /** 服务端在无任何已保存版本时自动落库 */
  autoPersistFirstVersion?: boolean;
};

export default function WorldForgeWorkflowPanel({
  worldId,
  worldName,
  hasSavedVersion,
}: {
  worldId: string;
  worldName: string;
  /** 是否已有至少一个 world_versions 记录（新建世界为 false） */
  hasSavedVersion: boolean;
}) {
  const [profile, setProfile] = useState<Profile>("wf3");
  const [incrementTarget, setIncrementTarget] = useState<IncrementTarget>("none");
  const [brief, setBrief] = useState("");
  const [mergeWithLatest, setMergeWithLatest] = useState(true);
  /** 尚无版本时默认 true，避免跑完不落库 */
  const [persist, setPersist] = useState(() => !hasSavedVersion);
  const [maxReviewRounds, setMaxReviewRounds] = useState(
    WORLD_FORGE_DEFAULT_MAX_REVIEW_ROUNDS
  );
  const [includeLastDraftOnFail, setIncludeLastDraftOnFail] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resultJson, setResultJson] = useState<string | null>(null);
  const [stepsLog, setStepsLog] = useState<string>("");
  const [meta, setMeta] = useState<string>("");
  const [graphBlueprintJson, setGraphBlueprintJson] = useState<string | null>(
    null
  );
  const [progressRows, setProgressRows] = useState<ProgressRow[]>([]);

  function applyResultPayload(data: ForgeApiPayload, prof: Profile) {
    if (data.steps) {
      setStepsLog(JSON.stringify(data.steps, null, 2));
    }
    if (data.graphBlueprint != null) {
      setGraphBlueprintJson(JSON.stringify(data.graphBlueprint, null, 2));
    }

    if (data.ok === false) {
      setError(data.error ?? "流水线未成功");
      if (Array.isArray(data.errors) && data.errors.length > 0) {
        setError(`${data.error ?? ""} ${data.errors.join("；")}`);
      }
      if (data.lastReviewIssues?.length) {
        setMeta(`审查意见：\n${data.lastReviewIssues.join("\n")}`);
      }
      if (data.lastNormalizedJson && includeLastDraftOnFail) {
        try {
          const obj = JSON.parse(data.lastNormalizedJson) as unknown;
          setResultJson(JSON.stringify(obj, null, 2));
        } catch {
          setResultJson(data.lastNormalizedJson);
        }
      }
      return;
    }

    if (data.normalizedJson) {
      try {
        const obj = JSON.parse(data.normalizedJson) as unknown;
        setResultJson(JSON.stringify(obj, null, 2));
      } catch {
        setResultJson(data.normalizedJson);
      }
    }
    const metaLines: string[] = [];
    if (data.reviewWarnings?.length) {
      metaLines.push(
        `【已生成世界书/人物书稿】审查在最大轮次用尽后按「最佳努力」采纳当前 Canonical；下列项可后续打补丁：\n${data.reviewWarnings.join("\n")}`
      );
    }
    if (typeof data.reviewRoundsUsed === "number" && prof !== "wf0") {
      metaLines.push(
        `本轮协作结束：扩写/合成侧共 ${data.reviewRoundsUsed} 轮（含审查闭环）。下方为实时步骤与完整轨迹。`
      );
    } else if (data.ok && metaLines.length === 0) {
      metaLines.push("本轮协作完成（速览模式：无审查循环）。");
    }
    if (metaLines.length > 0) {
      setMeta(metaLines.join("\n\n"));
    }
    if (data.autoPersistFirstVersion) {
      setMeta(
        (m) =>
          `${m ? `${m}\n` : ""}已自动写入首个保存版本（当前世界此前无任何已存版本）。`
      );
    }
    if (data.persistError) {
      setError(`流水线成功但落库失败：${data.persistError}`);
    }
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setResultJson(null);
    setStepsLog("");
    setMeta("");
    setGraphBlueprintJson(null);
    setProgressRows([]);
    const raw = brief.trim();
    if (!raw) {
      setError("请填写大纲或设定文本。");
      return;
    }
    setBusy(true);
    const streamPath = `/api/worlds/${worldId}/world-forge/stream`;

    try {
      const res = await fetch(streamPath, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          profile,
          incrementTarget,
          rawBrief: raw,
          mergeWithLatest,
          persist,
          ...(profile !== "wf0"
            ? { maxReviewRounds, includeLastDraftOnFail }
            : {}),
        }),
      });

      if (!res.ok || !res.body) {
        const rawText = await res.text();
        let data: ForgeApiPayload = {};
        try {
          data = rawText ? (JSON.parse(rawText) as ForgeApiPayload) : {};
        } catch {
          /* ignore */
        }
        setError(
          data.error ??
            `流式接口异常（HTTP ${res.status}）。片段：${rawText.slice(0, 320)}`
        );
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let sawResult = false;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const t = line.trim();
          if (!t) continue;
          let msg: Record<string, unknown>;
          try {
            msg = JSON.parse(t) as Record<string, unknown>;
          } catch {
            setError(`无法解析流式行：${t.slice(0, 120)}`);
            continue;
          }
          const typ = msg.type as string;
          if (typ === "fatal") {
            setError(
              (msg.error as string) ??
                `致命错误（status ${String(msg.status ?? "")}）`
            );
            return;
          }
          if (typ === "progress") {
            const label = String(msg.label ?? msg.id ?? "步骤");
            const ok = Boolean(msg.ok);
            const index = Number(msg.index ?? 0);
            const id = String(msg.id ?? "step");
            setProgressRows((prev) => [
              ...prev,
              { key: `${index}-${id}`, label, ok },
            ]);
          }
          if (typ === "result") {
            sawResult = true;
            const { type: _t, ...rest } = msg;
            applyResultPayload(rest as ForgeApiPayload, profile);
          }
        }
      }

      if (!sawResult) {
        setError("本轮未拿到最终结果，请稍后重试。");
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(`请求失败：${msg}`);
    } finally {
      setBusy(false);
    }
  }

  const pathHint =
    SHORT_PATH_OPTIONS.find((o) => o.value === profile)?.hint ?? "";

  const runningHint =
    busy && progressRows.length > 0
      ? progressRows[progressRows.length - 1]!.label
      : null;

  return (
    <div className="panel" style={{ marginTop: "1rem" }}>
      <h2 style={{ marginTop: 0, marginBottom: "0.4rem" }}>AI 共创世界</h2>
      <p className="muted" style={{ marginTop: 0 }}>
        世界：<strong>{worldName}</strong>。输入你的目标后，系统会自动完成分析、扩写和整合。
        你可以反复提交，持续优化这个世界。
      </p>

      <form onSubmit={onSubmit}>
        <label htmlFor="wf-brief" style={{ fontWeight: 600 }}>本轮输入</label>
        <textarea
          id="wf-brief"
          className="input"
          rows={10}
          value={brief}
          onChange={(e) => setBrief(e.target.value)}
          placeholder="例如：补充两个关键角色；完善势力冲突；把时间线理顺；新增世界规则。"
          style={{ marginTop: "0.35rem", resize: "vertical" }}
        />
        <div
          className="row"
          style={{
            marginTop: "0.6rem",
            flexWrap: "wrap",
            gap: "0.5rem",
            alignItems: "center",
            padding: "0.6rem 0.7rem",
            border: "1px solid var(--border)",
            borderRadius: "10px",
            background: "rgba(255,255,255,0.01)",
          }}
        >
          <span className="muted" style={{ fontSize: "0.85rem" }}>
            快速指令：
          </span>
          <button
            type="button"
            className="button secondary"
            style={{ fontSize: "0.82rem", padding: "0.32rem 0.6rem" }}
            onClick={() => {
              setBrief(buildAddCharactersPrompt(1));
              setMergeWithLatest(true);
              setIncrementTarget("character");
            }}
          >
            一键新增 1 角色
          </button>
          <button
            type="button"
            className="button secondary"
            style={{ fontSize: "0.82rem", padding: "0.32rem 0.6rem" }}
            onClick={() => {
              setBrief(buildAddCharactersPrompt(2));
              setMergeWithLatest(true);
              setIncrementTarget("character");
            }}
          >
            一键新增 2 角色
          </button>
          <button
            type="button"
            className="button secondary"
            style={{ fontSize: "0.82rem", padding: "0.32rem 0.6rem" }}
            onClick={() => {
              setBrief(buildAddCharactersPrompt(3));
              setMergeWithLatest(true);
              setIncrementTarget("character");
            }}
          >
            一键新增 3 角色
          </button>
        </div>

        <details style={{ marginTop: "0.85rem" }}>
          <summary className="muted" style={{ cursor: "pointer" }}>
            高级选项
          </summary>
          <p className="muted" style={{ marginTop: "0.5rem", fontSize: "0.9rem" }}>
            默认推荐「完整创作」。如果你更在意速度，可以切换到更快的模式。
          </p>
          <label htmlFor="wf-short-path" style={{ display: "block", marginTop: "0.35rem" }}>
            <span className="muted">路径</span>
            <select
              id="wf-short-path"
              className="input"
              style={{ display: "block", marginTop: "0.25rem", maxWidth: "100%" }}
              value={profile}
              onChange={(e) => setProfile(e.target.value as Profile)}
            >
              {SHORT_PATH_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <label
            htmlFor="wf-increment-target"
            style={{ display: "block", marginTop: "0.55rem" }}
          >
            <span className="muted">增量目标</span>
            <select
              id="wf-increment-target"
              className="input"
              style={{ display: "block", marginTop: "0.25rem", maxWidth: "100%" }}
              value={incrementTarget}
              onChange={(e) => setIncrementTarget(e.target.value as IncrementTarget)}
            >
              <option value="none">自动（按输入判断）</option>
              <option value="character">新增人物（轻量）</option>
              <option value="location">新增地点（轻量）</option>
              <option value="organization">新增组织（轻量）</option>
            </select>
          </label>
          <p className="muted" style={{ marginTop: "0.35rem", fontSize: "0.85rem" }}>
            选择增量目标后，会跳过图谱与并行三轨，优先走轻量增量流程。
          </p>
          {pathHint ? (
            <p className="muted" style={{ marginTop: "0.35rem", fontSize: "0.85rem" }}>
              {pathHint}
            </p>
          ) : null}
        </details>

        <div
          className="row"
          style={{
            marginTop: "0.8rem",
            flexWrap: "wrap",
            gap: "1rem",
            alignItems: "center",
            padding: "0.7rem",
            border: "1px solid var(--border)",
            borderRadius: "10px",
            background: "rgba(255,255,255,0.01)",
          }}
        >
          <label style={{ display: "flex", alignItems: "center", gap: "0.35rem" }}>
            <input
              type="checkbox"
              checked={mergeWithLatest}
              onChange={(e) => setMergeWithLatest(e.target.checked)}
            />
            与当前最新版本合并
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: "0.35rem" }}>
            <input
              type="checkbox"
              checked={persist}
              onChange={(e) => setPersist(e.target.checked)}
            />
            成功后写入新版本
          </label>
          {!hasSavedVersion ? (
            <span className="muted" style={{ fontSize: "0.85rem", maxWidth: "28rem" }}>
              当前世界<strong>还没有任何已保存版本</strong>：已默认勾选上项；即使取消勾选，服务端也会在成功时
              <strong>自动创建首版</strong>，避免白跑。
            </span>
          ) : null}
          {profile !== "wf0" ? (
            <>
              <label style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                最大审查轮次
                <select
                  className="input"
                  style={{ width: "auto", minWidth: "4rem" }}
                  value={maxReviewRounds}
                  onChange={(e) => setMaxReviewRounds(Number(e.target.value))}
                >
                  {Array.from(
                    { length: WORLD_FORGE_MAX_REVIEW_ROUNDS_CAP },
                    (_, i) => i + 1
                  ).map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: "0.35rem" }}>
                <input
                  type="checkbox"
                  checked={includeLastDraftOnFail}
                  onChange={(e) => setIncludeLastDraftOnFail(e.target.checked)}
                />
                失败时保留最后草稿
              </label>
            </>
          ) : null}
        </div>
        <button
          type="submit"
          className="button primary"
          style={{ marginTop: "0.85rem", minWidth: "9.2rem" }}
          disabled={busy}
        >
          {busy
            ? runningHint
              ? `进行中：${runningHint}…`
              : "AI 正在创作…"
            : "开始生成"}
        </button>
      </form>

      {progressRows.length > 0 ? (
        <div
          style={{
            marginTop: "1rem",
            padding: "0.75rem",
            border: "1px solid var(--border)",
            borderRadius: "10px",
            background: "rgba(255,255,255,0.01)",
          }}
        >
          <h3 style={{ marginBottom: "0.35rem" }}>实时进度（每完成一步推送）</h3>
          <ol
            style={{
              margin: 0,
              paddingLeft: "1.25rem",
              fontSize: "0.9rem",
              lineHeight: 1.6,
            }}
          >
            {progressRows.map((r) => (
              <li key={r.key} style={{ color: r.ok ? "var(--success, #6b8)" : "var(--danger)" }}>
                {r.ok ? "✓" : "✗"} {r.label}
              </li>
            ))}
          </ol>
          {busy ? <p className="muted" style={{ marginTop: "0.35rem", fontSize: "0.85rem" }}>正在处理，请稍候…</p> : null}
        </div>
      ) : null}

      {error ? (
        <p className="muted" style={{ color: "var(--danger)", marginTop: "0.75rem" }}>
          {error}
        </p>
      ) : null}
      {meta ? (
        <p className="muted" style={{ marginTop: "0.5rem", whiteSpace: "pre-wrap" }}>
          {meta}
        </p>
      ) : null}

      {stepsLog || graphBlueprintJson ? (
        <details style={{ marginTop: "1rem" }}>
          <summary className="muted" style={{ cursor: "pointer" }}>
            查看调试信息
          </summary>
          {stepsLog ? (
            <div style={{ marginTop: "0.5rem" }}>
              <h3 style={{ marginBottom: "0.35rem" }}>步骤轨迹（JSON）</h3>
              <pre
                className="code-inline"
                style={{
                  display: "block",
                  padding: "0.75rem",
                  overflow: "auto",
                  maxHeight: "22rem",
                  fontSize: "0.8rem",
                }}
              >
                {stepsLog}
              </pre>
            </div>
          ) : null}
          {graphBlueprintJson ? (
            <div style={{ marginTop: "0.75rem" }}>
              <h3 style={{ marginBottom: "0.35rem" }}>图谱中间结果</h3>
              <pre
                className="code-inline"
                style={{
                  display: "block",
                  padding: "0.75rem",
                  overflow: "auto",
                  maxHeight: "18rem",
                  fontSize: "0.8rem",
                }}
              >
                {graphBlueprintJson}
              </pre>
            </div>
          ) : null}
        </details>
      ) : null}

      {resultJson ? (
        <div style={{ marginTop: "1rem" }}>
          <h3 style={{ marginBottom: "0.35rem" }}>
            本轮 Canonical 结果{error ? "（末轮草稿）" : ""}
          </h3>
          <pre
            className="code-inline"
            style={{
              display: "block",
              padding: "0.75rem",
              overflow: "auto",
              maxHeight: "24rem",
              fontSize: "0.8rem",
            }}
          >
            {resultJson}
          </pre>
          {!error ? (
            <p className="muted" style={{ fontSize: "0.85rem" }}>
              <Link href={`/worlds/${worldId}/versions`}>版本页</Link>
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
