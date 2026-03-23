import path from "node:path";

/** 为 true 时掷骰走 MCP stdio 子进程（@canonweave/mcp-dice-roller），否则内联 rollDiceFromExpression。 */
export function isMcpDiceEnabled(): boolean {
  const v = process.env.CW_USE_MCP_DICE?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/**
 * MCP 骰子入口 JS 的绝对路径。
 * 默认相对 `process.cwd()`：`../../mcp-servers/dice-roller/dist/index.js`（在 `apps/web` 下执行 dev/build 时正确）。
 */
export function getMcpDiceServerScriptPath(): string {
  const custom = process.env.CW_MCP_DICE_SERVER?.trim();
  if (custom) {
    return path.isAbsolute(custom)
      ? custom
      : path.resolve(/* turbopackIgnore: true */ process.cwd(), custom);
  }
  return path.resolve(
    /* turbopackIgnore: true */ process.cwd(),
    "..",
    "..",
    "mcp-servers",
    "dice-roller",
    "dist",
    "index.js"
  );
}

/** world_reader / world_writer MCP 入口（@canonweave/mcp-world-tools） */
/**
 * 为 true 时，酒馆 `/api/chat` 真实模型路径会向模型挂载工具（掷骰 + world_reader，可选 world_writer），
 * 由模型按需调用，底层仍走现有 MCP stdio 封装。
 */
export function isAgentMcpEnabled(): boolean {
  const v = process.env.CW_AGENT_MCP?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/**
 * 为 true 时，酒馆 Agent 工具路径启用 ReAct 规范（Thought → Action → Observation → Thought），
 * 并在 SSE / session_event_logs 中输出 `react_thought` / `react_observation`。
 * 需同时开启 {@link isAgentMcpEnabled} 方生效。
 */
export function isReactCognitiveFrameworkEnabled(): boolean {
  const v = process.env.CW_REACT_FRAMEWORK?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/**
 * 为 true 时在 Agent 工具集中注册 `world_writer`（可改库）。默认关闭以降低误操作风险。
 */
export function isAgentWorldWriteEnabled(): boolean {
  const v = process.env.CW_AGENT_ALLOW_WORLD_WRITE?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/** 工具循环最大步数（含工具调用与后续生成），默认 12，范围 2–32 */
export function getAgentMcpMaxSteps(): number {
  const raw = process.env.CW_AGENT_MCP_MAX_STEPS?.trim();
  const n = raw ? parseInt(raw, 10) : 12;
  if (!Number.isFinite(n) || n < 2) return 12;
  if (n > 32) return 32;
  return n;
}

/**
 * 为 true 时关闭「世界书 AI 解析」导入路径（演示站可设 `CW_WORLD_IMPORT_AGENT=0`）。
 * 默认 false（允许，由用户在导入页勾选并消耗模型配额）。
 */
export function isWorldImportAgentDisabled(): boolean {
  const v = process.env.CW_WORLD_IMPORT_AGENT?.trim().toLowerCase();
  return v === "0" || v === "false" || v === "off" || v === "no";
}

export function getMcpWorldToolsServerScriptPath(): string {
  const custom = process.env.CW_MCP_WORLD_SERVER?.trim();
  if (custom) {
    return path.isAbsolute(custom)
      ? custom
      : path.resolve(/* turbopackIgnore: true */ process.cwd(), custom);
  }
  return path.resolve(
    /* turbopackIgnore: true */ process.cwd(),
    "..",
    "..",
    "mcp-servers",
    "world-tools",
    "dist",
    "index.js"
  );
}
