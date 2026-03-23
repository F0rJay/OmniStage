import ChatPanel from "./chat-panel";
import DeleteSessionButton from "./delete-session-button";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import {
  ensureThread,
  getTavernCharacterForUser,
  listMessagesByThread,
} from "@/lib/db";
import { tryInsertAssistantFirstMesForEmptyThread } from "@/lib/tavern-first-mes";
import { isChatMockMode } from "@/lib/llm";
import {
  getDreA2aInteractionRounds,
  getDreA2aRedisUrl,
  getDreIntentLlmMode,
  isDreMemoryEnabled,
  isDreWorldEntityAnchorsEnabled,
  isDynamicRpEngineEnabled,
} from "@/lib/dynamic-rp-config";
import {
  isAgentMcpEnabled,
  isReactCognitiveFrameworkEnabled,
} from "@/lib/mcp-config";
import { parseThreadSessionStateJson } from "@/lib/session-state";

type SessionPageProps = {
  params: Promise<{ sessionId: string }>;
};

export default async function TavernSessionPage({ params }: SessionPageProps) {
  const { sessionId } = await params;
  const cookieStore = await cookies();
  const userId = cookieStore.get("cw_user_id")?.value;
  if (!userId) {
    redirect("/sign-in");
  }

  const thread = (() => {
    try {
      return ensureThread(sessionId, userId);
    } catch {
      redirect("/tavern");
    }
  })();
  tryInsertAssistantFirstMesForEmptyThread(sessionId, userId);
  const assistantCharId = thread.assistant_character_id?.trim() || "";
  const assistantRow = assistantCharId
    ? getTavernCharacterForUser(assistantCharId, userId)
    : null;
  const initialAssistantCharacterName = assistantRow?.name?.trim() || null;

  const initialMessages = listMessagesByThread(sessionId)
    .filter(
      (message): message is typeof message & { role: "user" | "assistant" } =>
        message.role === "assistant" || message.role === "user"
    )
    .map((message) => ({
      role: message.role,
      content: message.content,
      ...(message.role === "assistant" && message.speaker_label
        ? { speakerLabel: message.speaker_label }
        : {}),
    }));

  return (
    <main className="page-shell">
      <div className="panel">
        <div
          className="row"
          style={{
            justifyContent: "space-between",
            alignItems: "flex-start",
            flexWrap: "wrap",
            gap: "0.75rem",
            marginBottom: "0.35rem",
          }}
        >
          <h1 style={{ marginTop: 0, marginBottom: 0 }}>会话</h1>
          <DeleteSessionButton sessionId={sessionId} />
        </div>
        <p className="muted" style={{ fontSize: "0.8rem", wordBreak: "break-all" }}>
          ID：{sessionId}
        </p>
        <p className="muted">
          可选绑定<strong>世界版本</strong>，将对应 Canonical 设定注入系统提示；模型经 LiteLLM
          网关时需先启动代理并配置环境变量，或使用 <span className="code-inline">CW_CHAT_MOCK=1</span>{" "}
          体验演示流。
        </p>
        {isAgentMcpEnabled() ? (
          <p className="muted" style={{ marginBottom: 0 }}>
            <strong>Agent</strong>：<span className="code-inline">CW_AGENT_MCP=1</span>{" "}
            已开启；模型可在对话中自动调用掷骰与世界书工具（需模型支持 function calling）。
            {isReactCognitiveFrameworkEnabled() ? (
              <>
                {" "}
                已同时开启 <span className="code-inline">CW_REACT_FRAMEWORK</span>
                ：工具调用前需可见 <strong>Thought:</strong>，返回记为{" "}
                <strong>Observation</strong>（见 <span className="code-inline">docs/react-cognitive-framework.md</span>）。
              </>
            ) : null}
            {isChatMockMode() ? (
              <>
                {" "}
                当前 <span className="code-inline">CW_CHAT_MOCK=1</span>，Mock 流下不会挂载工具。
              </>
            ) : null}
          </p>
        ) : null}
      </div>
      <ChatPanel
        sessionId={sessionId}
        initialMessages={initialMessages}
        initialModel={{
          provider: thread.model_provider,
          modelId: thread.model_id,
        }}
        initialWorldVersionId={thread.world_version_id}
        initialPersonaId={thread.persona_id}
        initialActiveCharacterBoundEntityId={
          thread.active_character_bound_entity_id
        }
        initialAssistantCharacterId={thread.assistant_character_id}
        initialAssistantCharacterName={initialAssistantCharacterName}
        initialSessionState={parseThreadSessionStateJson(thread.session_state_json)}
        agentMcpConfigured={isAgentMcpEnabled()}
        chatMockConfigured={isChatMockMode()}
        dynamicRpConfigured={isDynamicRpEngineEnabled()}
        dreIntentLlmMode={getDreIntentLlmMode()}
        dreA2aInteractionRounds={getDreA2aInteractionRounds()}
        dreA2aRedisConfigured={Boolean(getDreA2aRedisUrl())}
        dreMemoryConfigured={isDreMemoryEnabled()}
        dreWorldEntitiesConfigured={isDreWorldEntityAnchorsEnabled()}
        reactFrameworkConfigured={isReactCognitiveFrameworkEnabled()}
      />
    </main>
  );
}
