# ReAct 认知框架（酒馆 Agent 工具）

在开启 **Agent MCP**（`CW_AGENT_MCP=1`）时，可额外开启 **`CW_REACT_FRAMEWORK=1`**，让模型在调用掷骰、世界书读写等工具时遵循可见的推理链条，便于 TRPG 场景下审计与回放。

## 链条

1. **Thought**：模型在**同一条可见回复流**中，在发起工具调用**之前**写出 `Thought:`（及中文说明），说明为何调用、期望得到什么。
2. **Action**：由 SDK 发起的 **MCP / function 工具调用**（对用户而言即「动作」）。
3. **Observation**：**工具返回内容**即 Observation；不要求模型单独写 `Observation:` 标签，服务端会把返回摘要通过 SSE 与事件流标为 observation。
4. **Thought**：收到 Observation 后，模型在后续正文中再次以 `Thought:` 承接，再继续叙述或调用下一工具。

## 配置

| 变量 | 说明 |
|------|------|
| `CW_AGENT_MCP=1` | 必须：挂载 Agent 工具 |
| `CW_REACT_FRAMEWORK=1` | 开启 ReAct 系统提示与轨迹采集 |

`CW_CHAT_MOCK=1` 时不挂载真实工具，ReAct 无意义。

## 可观测性

- **SSE**：`react_thought`（每次 `tool-call` 前解析缓冲区）、`react_observation`（`tool-result` / `tool-error`）。
- **事件日志**：`react_thought`、`react_observation`（与 `agent_tool_*` 并列）。
- **UI**：助手气泡下「ReAct 轨迹」折叠块；若本步未检测到规范 `Thought:`，会标记为不合规。

## 边界

当前实现依赖**模型遵守提示词**在工具调用前输出 `Thought:`。服务端只能**检测与标注**，无法在协议层 100% 禁止「无 Thought 的 tool call」。若需硬约束，需改为「先结构化输出 Thought，再单独执行工具」等多段流水线架构。

相关实现：`apps/web/src/lib/react-cognitive.ts`、`apps/web/src/app/api/chat/route.ts`、`apps/web/src/app/tavern/sessions/[sessionId]/chat-panel.tsx`。
