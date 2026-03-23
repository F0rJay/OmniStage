import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import { stepCountIs } from "ai";
import {
  countUserMessagesInThread,
  ensureThread,
  getPersonaForUser,
  getTavernCharacterForUser,
  getWorldVersionWithWorldForUser,
  insertInsight,
  insertMessage,
  insertSessionEvent,
  listInsightsForTavernContext,
  listMessagesByThread,
  mergeThreadSessionState,
} from "@/lib/db";
import {
  formatSessionStateForPrompt,
  parseThreadSessionStateJson,
} from "@/lib/session-state";
import {
  augmentLastUserMessageWithDice,
  diceToolPayload,
  formatDiceForPrompt,
  rollDiceFromExpression,
  type DiceRollResult,
} from "@/lib/dice";
import {
  getAgentMcpMaxSteps,
  isAgentMcpEnabled,
  isAgentWorldWriteEnabled,
  isMcpDiceEnabled,
  isReactCognitiveFrameworkEnabled,
} from "@/lib/mcp-config";
import { resolveDiceForChatMessage, rollDiceViaMcp } from "@/lib/mcp-dice";
import {
  isDreMemoryEnabled,
  isDreStrictGroupFormatEnabled,
  isDreWorldEntityAnchorsEnabled,
  isDynamicRpEngineEnabled,
} from "@/lib/dynamic-rp-config";
import {
  isLayeredMemoryDialogueExtractEnabled,
  isLayeredMemoryEnabled,
} from "@/lib/layered-memory-config";
import { runLayeredMemorySupervisorExtract } from "@/lib/layered-memory-extract";
import {
  formatLayeredMemoryContextBlock,
  parsePrivateMemoryFromSessionState,
  parseSharedMemoryFromSessionState,
  privateMemoryToPatchObject,
  sharedMemoryToPatchObject,
} from "@/lib/layered-memory";
import { isMem0Enabled } from "@/lib/mem0-config";
import { ingestMem0Turn, searchMem0ForTurn } from "@/lib/canonweave-mem0";
import {
  dreMemoryToPatchObject,
  formatDreMemoryDirectorAppend,
  parseDreMemoryFromSessionState,
  runDreMemoryExtraction,
} from "@/lib/dre-memory";
import { buildDreWorldEntityContextForTurn } from "@/lib/dre-world-entities";
import {
  auditAndRepairRoleBlockFormat,
  DRE_DIALOGUE_MODE_APPEND,
  ensureGroupSpeakerMarkers,
  formatDynamicRpDirectorSystemAppend,
  formatLastDiceForDynamicRp,
  getActiveNpcNamesFromSessionState,
  planDirectorDiceForActionTurn,
  planDynamicAutoTurn,
  runDynamicRpActionBeat,
} from "@/lib/dynamic-rp-engine";
import { resolveDynamicRpIntent } from "@/lib/dynamic-rp-intent-llm";
import { extractThoughtBeforeToolCall } from "@/lib/react-cognitive";
import {
  buildAgentToolsSystemAppend,
  buildTavernAgentTools,
  truncateJsonForSse,
} from "@/lib/tavern-agent-tools";
import {
  buildCoreMessages,
  formatWorldContextForPrompt,
  getApiKeyForProvider,
  isChatMockMode,
  missingKeyMessage,
  streamTavernCompletion,
} from "@/lib/llm";
import { buildTavernInjectedWorldContext } from "@/lib/tavern-rp-context";
import {
  formatAssistantMessageForPersistence,
  TAVERN_SPEAKER_LINE_PROTOCOL,
} from "@/lib/chat-speaker";

export const runtime = "nodejs";

type ChatRequestBody = {
  sessionId?: string;
  text?: string;
  /** auto: 无用户输入，世界/NPC 主动推进一拍 */
  mode?: "auto";
  /** 自动档导演节奏：保守/标准/激进 */
  autoProfile?: "conservative" | "standard" | "aggressive";
};

type StreamEvent =
  | {
      event: "turn_started";
      data: {
        sessionId: string;
        requestText: string;
        modelProvider: string;
        modelId: string;
        turnNumber: number;
      };
    }
  | { event: "tool_called"; data: Record<string, unknown> }
  | {
      event: "agent_tool_finished";
      data: {
        toolName: string;
        toolCallId: string;
        ok: boolean;
        outputPreview?: string;
        error?: string;
        dice?: Record<string, unknown>;
      };
    }
  | {
      event: "state_patched";
      data: { keys: string[]; state: Record<string, unknown> };
    }
  | { event: "token"; data: { delta: string } }
  | {
      event: "turn_finished";
      data: {
        sessionId: string;
        message: string;
        /** 已去掉说话者首行的正文，供客户端覆盖流式缓冲 */
        displayMessage?: string;
        speakerLabel?: string | null;
      };
    }
  | { event: "error"; data: { message: string } }
  | {
      event: "dre_intent";
      data: { kind: string; reason: string; source?: string };
    }
  | { event: "dre_environment"; data: Record<string, unknown> }
  | {
      event: "dre_a2a";
      data: {
        summary: string;
        npcLines: Array<{ name: string; intent: string }>;
        roundsUsed?: number;
        beatId?: string;
        transcriptPreview?: string;
      };
    }
  | {
      event: "dre_memory";
      data: {
        addedFacts: number;
        newConflicts: number;
        totalEntries: number;
        totalConflicts: number;
      };
    }
  | {
      event: "dre_entities";
      data: {
        method: string;
        pickedIds: string[];
        pickedNames: string[];
      };
    }
  | {
      event: "dre_autopilot_plan";
      data: {
        shouldAdvance: boolean;
        reason: string;
        npcNames: string[];
        profile?: "conservative" | "standard" | "aggressive";
      };
    }
  | {
      event: "react_thought";
      data: {
        toolName: string;
        toolCallId: string;
        thought: string | null;
        compliant: boolean;
        precedingTail?: string;
      };
    }
  | {
      event: "react_observation";
      data: {
        toolName: string;
        toolCallId: string;
        preview: string;
        ok: boolean;
        error?: string;
      };
    }
  | {
      event: "mem0_context";
      data: { hits: number; memories: string[] };
    }
  | {
      event: "layered_memory";
      data: {
        phase: "inject" | "supervisor";
        sharedGoalCount: number;
        privateNpcBuckets: number;
        insightsInserted: number;
      };
    };

function logTurnEvent(
  userId: string,
  threadId: string,
  eventType: string,
  payload: Record<string, unknown>
): void {
  insertSessionEvent({
    id: randomUUID(),
    threadId,
    userId,
    eventType,
    payload,
  });
}

function toSse(event: StreamEvent): string {
  return `event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`;
}

function pickAddressedSpeaker(
  userText: string,
  speakers: string[]
): string | null {
  const t = userText.trim();
  if (!t) return null;
  for (const s of speakers) {
    const name = s.trim();
    if (!name) continue;
    if (t.includes(name)) return name;
  }
  return null;
}

function isLikelyCharacterName(name: string): boolean {
  const n = name.trim();
  if (!n) return false;
  if (n === "场景") return false;
  const badWholeNames = new Set([
    "好的",
    "好的好的",
    "嗯",
    "嗯嗯",
    "啊",
    "哦",
    "哈哈",
    "呵呵",
    "是的",
    "不是",
    "当然",
    "小子",
    "朋友",
    "新朋友",
  ]);
  if (badWholeNames.has(n)) return false;
  if (n.length < 2 || n.length > 8) return false;
  if (!/^[A-Za-z\u4e00-\u9fa5·]+$/.test(n)) return false;
  // 过滤更像“称号/抽象描述”的短语，避免被误当角色名
  if (n.length >= 4 && /[之其而乃若于]/.test(n)) return false;
  if (/(场景|旁白|日志|条目|记录|补充|章节|目录|系统|NPC)/.test(n)) return false;
  // 过滤时间/章节/路线标签，避免被写回 speaker pool
  if (/(时期|时代|阶段|年间|纪元|线|篇|卷|章|幕|节)$/.test(n)) return false;
  const badNameStarts = [
    "停",
    "微",
    "翻",
    "眯",
    "放",
    "看",
    "推",
    "走",
    "试",
    "正",
    "将",
    "拿",
    "掏",
    "补",
    "记",
    "观",
    "描",
    "注",
    "收",
    "开",
    "合",
    "翻开",
    "平静",
    "随后",
    "然后",
    "于是",
    "立刻",
    "忽然",
    "突然",
    "正在",
    "缓缓",
    "慢慢",
    "轻轻",
    "悄悄",
  ];
  if (badNameStarts.some((x) => n.startsWith(x))) return false;
  return true;
}

function extractAddressedNamesFromUserText(text: string): string[] {
  const t = text.trim();
  if (!t) return [];
  const set = new Set<string>();
  for (const m of t.matchAll(/([A-Za-z\u4e00-\u9fa5·]{2,8})[，,：:！!？?]/g)) {
    const n = (m[1] ?? "").trim();
    if (isLikelyCharacterName(n)) set.add(n);
  }
  return [...set].slice(0, 4);
}

function isPlaceholderSceneNpc(name: string): boolean {
  return /^场景\s*NPC/.test(name.trim());
}

function extractLikelyCharacterNames(text: string): string[] {
  const t = text.trim();
  if (!t) return [];
  const set = new Set<string>();
  const add = (x: string) => {
    const n = x.trim();
    if (isLikelyCharacterName(n)) set.add(n);
  };
  for (const m of t.matchAll(/【([^】\n]{1,24})】/g)) add(m[1] ?? "");
  // 兼容「【说话者：角色名】」这种 UI 协议
  for (const m of t.matchAll(/【\s*说话者\s*[:：]\s*([^】\n]{1,24})】/g)) {
    add(m[1] ?? "");
  }
  // 兼容 `[CW_SPEAKER:角色名]` 协议
  for (const m of t.matchAll(/\[CW_SPEAKER:([^\]\n]{1,24})\]/g)) {
    add(m[1] ?? "");
  }
  // 兼容“句首直接给出人名”的情况：如「弗兰德院长推着眼镜头的动作……」
  for (const m of t.matchAll(/^\s*([A-Za-z\u4e00-\u9fa5·]{2,8})(?=[，,。！？!?:：、\s])/gm)) {
    add(m[1] ?? "");
  }
  // 兼容“句首人名 + 动作动词”且中间无标点的写法：如「赵无极愣了一下」
  for (const m of t.matchAll(/^\s*([\u4e00-\u9fa5·]{2,6})(?=(愣|笑|看|说|问|点|抬|皱|眯|沉|收|摆|挠|叹|道|答|走|站|坐|转|望|盯|拍|推|拔|握|咳))/gm)) {
    add(m[1] ?? "");
  }
  for (const m of t.matchAll(/\[([^\]\n]{1,24})\]/g)) add(m[1] ?? "");
  for (const m of t.matchAll(/^[（(]\s*([A-Za-z\u4e00-\u9fa5·]{2,12})/gm)) {
    add(m[1] ?? "");
  }
  for (const m of t.matchAll(/([A-Za-z\u4e00-\u9fa5·]{2,8})[：:]/g)) add(m[1] ?? "");
  return [...set].slice(0, 8);
}

function mergeRuntimeSpeakerCandidates(input: {
  seed: string[];
  texts: Array<string | null | undefined>;
}): string[] {
  const set = new Set<string>();
  for (const s of input.seed) {
    const n = s.trim();
    if (!n || isPlaceholderSceneNpc(n)) continue;
    if (!isLikelyCharacterName(n)) continue;
    set.add(n);
  }
  for (const t of input.texts) {
    if (!t) continue;
    for (const n of extractLikelyCharacterNames(t)) {
      const v = n.trim();
      if (!v || isPlaceholderSceneNpc(v)) continue;
      if (!isLikelyCharacterName(v)) continue;
      set.add(v);
    }
  }
  return [...set].slice(0, 10);
}

export async function POST(request: Request) {
  const cookieStore = await cookies();
  const userId = cookieStore.get("cw_user_id")?.value;
  if (!userId) {
    return Response.json({ error: "Unauthorized." }, { status: 401 });
  }

  let body: ChatRequestBody;

  try {
    body = (await request.json()) as ChatRequestBody;
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const sessionId = body.sessionId?.trim();
  const mode = body.mode;
  const autoProfile =
    body.autoProfile === "conservative" ||
    body.autoProfile === "aggressive" ||
    body.autoProfile === "standard"
      ? body.autoProfile
      : "standard";
  const rawText = body.text?.trim();
  const isAutoTurn = mode === "auto";
  const text =
    rawText && rawText.length > 0
      ? rawText
      : isAutoTurn
        ? "（世界自主推进：让在场 NPC 主动互动并推进一拍）"
        : "";

  if (!sessionId || (!isAutoTurn && !text)) {
    return Response.json(
      { error: "sessionId is required; text is required unless mode=auto." },
      { status: 400 }
    );
  }

  let thread;
  try {
    thread = ensureThread(sessionId, userId);
  } catch {
    return Response.json({ error: "Forbidden thread access." }, { status: 403 });
  }

  let worldContextBlock: string | null = null;
  let canonicalJsonForDre: string | null = null;
  let threadWorldId: string | null = null;
  if (thread.world_version_id) {
    const bundle = getWorldVersionWithWorldForUser(thread.world_version_id, userId);
    if (bundle) {
      threadWorldId = bundle.versionRow.world_id;
      worldContextBlock = formatWorldContextForPrompt(
        bundle.worldName,
        bundle.versionRow.version,
        bundle.versionRow.canonical_json
      );
      canonicalJsonForDre = bundle.versionRow.canonical_json;
    }
  }

  const personaRow =
    thread.persona_id?.trim()
      ? getPersonaForUser(thread.persona_id.trim(), userId)
      : null;
  const assistantRow =
    thread.assistant_character_id?.trim()
      ? getTavernCharacterForUser(thread.assistant_character_id.trim(), userId)
      : null;
  worldContextBlock = buildTavernInjectedWorldContext({
    baseWorldBlock: worldContextBlock,
    assistantCharacter: assistantRow
      ? {
          name: assistantRow.name,
          characterCardJson: assistantRow.character_card_json,
        }
      : null,
    canonicalJson: canonicalJsonForDre,
    activeCharacterBoundEntityId: thread.active_character_bound_entity_id,
    persona: personaRow
      ? {
          name: personaRow.name,
          description: personaRow.description ?? "",
          title: personaRow.title,
        }
      : null,
  });

  if (!isAutoTurn) {
    insertMessage({
      id: randomUUID(),
      threadId: sessionId,
      role: "user",
      content: text,
    });
  }

  const useMock = isChatMockMode();
  const agentMcp = isAgentMcpEnabled() && !useMock;
  if (
    !useMock &&
    !getApiKeyForProvider(thread.model_provider)
  ) {
    return Response.json(
      { error: missingKeyMessage(thread.model_provider) },
      { status: 503 }
    );
  }

  const turnNumber = countUserMessagesInThread(sessionId) + (isAutoTurn ? 1 : 0);

  let diceResult: DiceRollResult | null = null;
  let diceViaMcp = false;
  try {
    const resolved = isAutoTurn ? null : await resolveDiceForChatMessage(text);
    if (resolved) {
      diceResult = resolved.result;
      diceViaMcp = resolved.viaMcp;
    }
  } catch (e) {
    return Response.json(
      {
        error:
          e instanceof Error
            ? e.message
            : "掷骰失败（MCP）。请检查 CW_USE_MCP_DICE 与 npm run build:mcp-dice。",
      },
      { status: 503 }
    );
  }

  const diceLine = diceResult ? formatDiceForPrompt(diceResult) : null;

  let statePatchPayload: {
    keys: string[];
    state: Record<string, unknown>;
  } | null = null;
  let mergedStateForPrompt = parseThreadSessionStateJson(
    thread.session_state_json
  );

  if (diceResult) {
    const { state, keys } = mergeThreadSessionState(sessionId, userId, {
      lastDice: {
        expression: diceResult.expression,
        total: diceResult.total,
        rolls: diceResult.rolls,
        at: new Date().toISOString(),
      },
    });
    mergedStateForPrompt = state;
    statePatchPayload = { keys, state };
    logTurnEvent(userId, sessionId, "state_patched", { keys, state });
  }

  let sessionStateHint = formatSessionStateForPrompt(mergedStateForPrompt);

  const encoder = new TextEncoder();

  if (useMock) {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        let timer: ReturnType<typeof setInterval> | undefined;

        logTurnEvent(userId, sessionId, "turn_started", {
          requestText: text,
          modelProvider: thread.model_provider,
          modelId: thread.model_id,
          turnNumber,
        });

        controller.enqueue(
          encoder.encode(
            toSse({
              event: "turn_started",
              data: {
                sessionId,
                requestText: text,
                modelProvider: thread.model_provider,
                modelId: thread.model_id,
                turnNumber,
              },
            })
          )
        );

        if (diceResult) {
          const toolPayload = diceToolPayload(diceResult, {
            transport: diceViaMcp ? "mcp_stdio" : "inline",
          });
          logTurnEvent(userId, sessionId, "tool_called", toolPayload);
          controller.enqueue(
            encoder.encode(toSse({ event: "tool_called", data: toolPayload }))
          );
        }

        if (statePatchPayload) {
          controller.enqueue(
            encoder.encode(
              toSse({ event: "state_patched", data: statePatchPayload })
            )
          );
        }

        const assistantBase =
          `酒馆侧耳听着你的话：「${text}」。` +
          "一盏暖黄的灯轻轻摇晃，你的下一步选择将牵动接下来的遭遇。";
        const assistantText = diceLine
          ? `【掷骰】${diceLine}\n\n${assistantBase}`
          : assistantBase;
        const chunks = assistantText.split(" ").map((word) => `${word} `);
        let currentChunkIndex = 0;

        timer = setInterval(() => {
          if (currentChunkIndex < chunks.length) {
            controller.enqueue(
              encoder.encode(
                toSse({
                  event: "token",
                  data: { delta: chunks[currentChunkIndex] },
                })
              )
            );
            currentChunkIndex += 1;
            return;
          }

          if (timer) clearInterval(timer);

          logTurnEvent(userId, sessionId, "turn_finished", {
            assistantChars: assistantText.length,
            mock: true,
          });
          controller.enqueue(
            encoder.encode(
              toSse({
                event: "turn_finished",
                data: { sessionId, message: assistantText },
              })
            )
          );
          insertMessage({
            id: randomUUID(),
            threadId: sessionId,
            role: "assistant",
            content: assistantText,
          });
          controller.close();
        }, 90);
      },
      cancel() {
        /* interval cleared on close */
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      },
    });
  }

  const historyRows = listMessagesByThread(sessionId);
  const lastAssistantSnippet =
    [...historyRows].reverse().find((r) => r.role === "assistant")?.content ??
    null;
  const coreMessages = augmentLastUserMessageWithDice(
    buildCoreMessages(historyRows),
    diceLine
  );

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let assistantText = "";
      let usedActionTurn = false;
      let actionTurnSpeakers: string[] = [];
      let addressedSpeaker: string | null = null;
      let formatReviewSpeakers: string[] = [];
      let formatReviewPreferred: string | null = null;
      const dreStrictGroupFormat = isDreStrictGroupFormatEnabled();

      try {
        logTurnEvent(userId, sessionId, "turn_started", {
          requestText: text,
          modelProvider: thread.model_provider,
          modelId: thread.model_id,
          turnNumber,
        });

        controller.enqueue(
          encoder.encode(
            toSse({
              event: "turn_started",
              data: {
                sessionId,
                requestText: text,
                modelProvider: thread.model_provider,
                modelId: thread.model_id,
                turnNumber,
              },
            })
          )
        );

        if (diceResult) {
          const toolPayload = diceToolPayload(diceResult, {
            transport: diceViaMcp ? "mcp_stdio" : "inline",
          });
          logTurnEvent(userId, sessionId, "tool_called", toolPayload);
          controller.enqueue(
            encoder.encode(toSse({ event: "tool_called", data: toolPayload }))
          );
        }

        if (statePatchPayload) {
          controller.enqueue(
            encoder.encode(
              toSse({ event: "state_patched", data: statePatchPayload })
            )
          );
        }

        let dreExtraSystemAppend: string | null = null;
        let useAgentToolsThisTurn = agentMcp;

        const layeredInsightRows =
          isLayeredMemoryEnabled() && !useMock
            ? listInsightsForTavernContext({
                userId,
                threadId: sessionId,
                worldId: threadWorldId,
              })
            : [];

        if (isDynamicRpEngineEnabled()) {
          let dreWorldDirectorAppend = "";
          let dreWorldHintForBeat = "";
          const baseActiveNpcs = getActiveNpcNamesFromSessionState(
            mergedStateForPrompt
          );
          let plannedActiveNpcs = baseActiveNpcs;
          let autoPlanShouldAdvance = true;
          let autoPlanReason = "";
          let dreWorldEntitySse: {
            method: string;
            pickedIds: string[];
            pickedNames: string[];
          } | null = null;

          if (canonicalJsonForDre && isDreWorldEntityAnchorsEnabled()) {
            const ent = await buildDreWorldEntityContextForTurn({
              canonicalJson: canonicalJsonForDre,
              userLine: text,
              lastAssistantSnippet,
              provider: thread.model_provider,
              modelId: thread.model_id,
            });
            dreWorldHintForBeat = ent.hintBlock;
            dreWorldDirectorAppend = ent.directorAppend;
            dreWorldEntitySse = ent.sse;
            if (ent.sse) {
              logTurnEvent(userId, sessionId, "dre_entities", ent.sse);
              controller.enqueue(
                encoder.encode(
                  toSse({
                    event: "dre_entities",
                    data: {
                      method: ent.sse.method,
                      pickedIds: ent.sse.pickedIds,
                      pickedNames: ent.sse.pickedNames,
                    },
                  })
                )
              );
            }
          }

          if (isAutoTurn) {
            const ap = await planDynamicAutoTurn({
              userLine: text,
              lastAssistantSnippet,
              worldContext: worldContextBlock,
              activeNpcs: baseActiveNpcs,
              profile: autoProfile,
              provider: thread.model_provider,
              modelId: thread.model_id,
            });
            autoPlanShouldAdvance = ap.shouldAdvance;
            autoPlanReason = ap.reason;
            if (ap.npcNames.length > 0) {
              plannedActiveNpcs = ap.npcNames;
            }
            const autoPlanPayload = {
              shouldAdvance: autoPlanShouldAdvance,
              reason: autoPlanReason,
              npcNames: plannedActiveNpcs,
              profile: autoProfile,
            };
            logTurnEvent(userId, sessionId, "dre_autopilot_plan", autoPlanPayload);
            controller.enqueue(
              encoder.encode(
                toSse({
                  event: "dre_autopilot_plan",
                  data: autoPlanPayload,
                })
              )
            );
          }

          let intent = await resolveDynamicRpIntent({
            text,
            provider: thread.model_provider,
            modelId: thread.model_id,
          });
          if (isAutoTurn) {
            intent = autoPlanShouldAdvance
              ? {
                  kind: "action",
                  reason: `导演自动档：推进剧情（${autoPlanReason}）`,
                  source: "hybrid",
                }
              : {
                  kind: "dialogue",
                  reason: `导演自动档：暂缓强推进（${autoPlanReason}）`,
                  source: "hybrid",
                };
          }
          logTurnEvent(userId, sessionId, "dre_intent", {
            kind: intent.kind,
            reason: intent.reason,
            source: intent.source,
          });
          controller.enqueue(
            encoder.encode(
              toSse({
                event: "dre_intent",
                data: {
                  kind: intent.kind,
                  reason: intent.reason,
                  source: intent.source,
                },
              })
            )
          );

          if (intent.kind === "action") {
            useAgentToolsThisTurn = false;
            const activeNpcs = plannedActiveNpcs;
            usedActionTurn = true;
            {
              const speakerSet = new Set<string>(activeNpcs);
              const primary = assistantRow?.name?.trim();
              if (primary) speakerSet.add(primary);
              actionTurnSpeakers = [...speakerSet];
            }
            addressedSpeaker = pickAddressedSpeaker(text, actionTurnSpeakers);
            let lastDiceHint = formatLastDiceForDynamicRp(mergedStateForPrompt);
            // 动作线：若用户本回合未给 /roll，则由导演主动判断是否掷骰并触发 MCP 骰子
            if (!diceResult) {
              const dicePlan = await planDirectorDiceForActionTurn({
                userLine: text,
                lastAssistantSnippet,
                worldContext: worldContextBlock,
                provider: thread.model_provider,
                modelId: thread.model_id,
              });
              logTurnEvent(userId, sessionId, "dre_director_dice_plan", {
                needRoll: dicePlan.needRoll,
                expression: dicePlan.expression,
                reason: dicePlan.reason,
              });
              if (dicePlan.needRoll && dicePlan.expression) {
                try {
                  const result = isMcpDiceEnabled()
                    ? await rollDiceViaMcp(dicePlan.expression)
                    : rollDiceFromExpression(dicePlan.expression);
                  if (result) {
                    const viaMcp = isMcpDiceEnabled();
                    const toolPayload = diceToolPayload(result, {
                      transport: viaMcp ? "mcp_stdio" : "inline",
                      source: "agent",
                    });
                    logTurnEvent(userId, sessionId, "tool_called", {
                      ...toolPayload,
                      source: "director_auto",
                      reason: dicePlan.reason,
                    });
                    controller.enqueue(
                      encoder.encode(
                        toSse({
                          event: "tool_called",
                          data: {
                            ...toolPayload,
                            source: "director_auto",
                            reason: dicePlan.reason,
                          },
                        })
                      )
                    );
                    const { state, keys } = mergeThreadSessionState(
                      sessionId,
                      userId,
                      {
                        lastDice: {
                          expression: result.expression,
                          total: result.total,
                          rolls: result.rolls,
                          at: new Date().toISOString(),
                        },
                      }
                    );
                    mergedStateForPrompt = state;
                    lastDiceHint = formatLastDiceForDynamicRp(state);
                    controller.enqueue(
                      encoder.encode(
                        toSse({
                          event: "state_patched",
                          data: { keys, state },
                        })
                      )
                    );
                    logTurnEvent(userId, sessionId, "state_patched", {
                      keys,
                      state,
                      via: "director_auto_dice",
                    });
                  }
                } catch (e) {
                  logTurnEvent(userId, sessionId, "dre_director_dice_failed", {
                    expression: dicePlan.expression,
                    error: e instanceof Error ? e.message : String(e),
                  });
                }
              }
            }
            const dreBeatId = randomUUID();
            const layeredMemHint =
              isLayeredMemoryEnabled() && !useMock
                ? formatLayeredMemoryContextBlock({
                    shared: parseSharedMemoryFromSessionState(
                      mergedStateForPrompt
                    ),
                    privateMap: parsePrivateMemoryFromSessionState(
                      mergedStateForPrompt
                    ),
                    insightRows: layeredInsightRows,
                    activeNpcNames: activeNpcs,
                  })
                : null;

            const bundle = await runDynamicRpActionBeat({
              threadId: sessionId,
              beatId: dreBeatId,
              userLine: text,
              lastAssistantSnippet,
              worldContext: worldContextBlock,
              lastDiceHint,
              worldEntityHint: dreWorldHintForBeat || null,
              layeredMemoryHint: layeredMemHint,
              activeNpcs,
              provider: thread.model_provider,
              modelId: thread.model_id,
            });

            if (layeredMemHint && isLayeredMemoryEnabled() && !useMock) {
              logTurnEvent(userId, sessionId, "layered_memory", {
                phase: "inject",
                sharedGoalCount: parseSharedMemoryFromSessionState(
                  mergedStateForPrompt
                ).goals.filter((g) => g.status === "active").length,
                privateNpcBuckets: Object.keys(
                  parsePrivateMemoryFromSessionState(mergedStateForPrompt)
                ).length,
                insightsInserted: 0,
              });
              controller.enqueue(
                encoder.encode(
                  toSse({
                    event: "layered_memory",
                    data: {
                      phase: "inject",
                      sharedGoalCount: parseSharedMemoryFromSessionState(
                        mergedStateForPrompt
                      ).goals.filter((g) => g.status === "active").length,
                      privateNpcBuckets: Object.keys(
                        parsePrivateMemoryFromSessionState(mergedStateForPrompt)
                      ).length,
                      insightsInserted: 0,
                    },
                  })
                )
              );
            }

            logTurnEvent(userId, sessionId, "dre_environment", {
              ...bundle.environment,
            });
            controller.enqueue(
              encoder.encode(
                toSse({
                  event: "dre_environment",
                  data: { ...bundle.environment } as Record<string, unknown>,
                })
              )
            );

            const npcLines = bundle.npcBeats.map((n) => ({
              name: n.name,
              intent: n.beat.intent_line,
            }));
            const transcriptPreview =
              bundle.a2aTranscript && bundle.a2aTranscript.length > 3200
                ? `${bundle.a2aTranscript.slice(0, 3200)}…`
                : bundle.a2aTranscript;
            logTurnEvent(userId, sessionId, "dre_a2a", {
              summary: bundle.a2a_summary,
              npcLines,
              roundsUsed: bundle.a2aRoundsUsed,
              beatId: bundle.dreBeatId,
              transcriptPreview,
            });
            controller.enqueue(
              encoder.encode(
                toSse({
                  event: "dre_a2a",
                  data: {
                    summary: bundle.a2a_summary,
                    npcLines,
                    roundsUsed: bundle.a2aRoundsUsed,
                    beatId: bundle.dreBeatId,
                    transcriptPreview,
                  },
                })
              )
            );

            const priorMemory = parseDreMemoryFromSessionState(
              mergedStateForPrompt
            );
            let memoryDirectorAppend = "";
            let memoryStats: {
              addedFacts: number;
              newConflicts: number;
            } | null = null;
            let memoryPatch: Record<string, unknown> | undefined;

            if (isDreMemoryEnabled()) {
              const mem = await runDreMemoryExtraction({
                userLine: text,
                bundle,
                prior: priorMemory,
                provider: thread.model_provider,
                modelId: thread.model_id,
              });
              memoryDirectorAppend = mem.directorAppend.trim();
              memoryStats = mem.stats;
              memoryPatch = dreMemoryToPatchObject(mem.next);
            }

            const prevDr = mergedStateForPrompt.dynamicRp;
            const prevDrObj =
              prevDr &&
              typeof prevDr === "object" &&
              !Array.isArray(prevDr)
                ? ({ ...(prevDr as Record<string, unknown>) } as Record<
                    string,
                    unknown
                  >)
                : {};
            const statePatch: Record<string, unknown> = {
              dynamicRp: {
                ...prevDrObj,
                lastIntent: "action",
                lastEventSummary: bundle.environment.event_summary,
                lastA2a: bundle.a2a_summary,
                lastA2aRounds: bundle.a2aRoundsUsed,
                lastBeatId: bundle.dreBeatId,
                lastAt: new Date().toISOString(),
                ...(dreWorldEntitySse?.pickedIds?.length
                  ? { lastEntityAnchors: dreWorldEntitySse.pickedIds }
                  : {}),
              },
            };
            if (memoryPatch) {
              statePatch.dreMemory = memoryPatch;
            }

            let layeredInsightsInserted = 0;
            if (isLayeredMemoryEnabled() && !useMock) {
              const priorS = parseSharedMemoryFromSessionState(
                mergedStateForPrompt
              );
              const priorP =
                parsePrivateMemoryFromSessionState(mergedStateForPrompt);
              const ex = await runLayeredMemorySupervisorExtract({
                userLine: text,
                bundle,
                lastAssistantSnippet,
                priorShared: priorS,
                priorPrivate: priorP,
                activeNpcs,
                beatId: dreBeatId,
                provider: thread.model_provider,
                modelId: thread.model_id,
              });
              statePatch.sharedMemory = sharedMemoryToPatchObject(ex.nextShared);
              statePatch.privateMemory = privateMemoryToPatchObject(
                ex.nextPrivate
              );
              for (const c of ex.insightCandidates) {
                if (c.scope === "world" && !threadWorldId) continue;
                insertInsight({
                  id: randomUUID(),
                  userId,
                  summary: c.summary,
                  scope: c.scope,
                  worldId: c.scope === "world" ? threadWorldId : null,
                  threadId: c.scope === "session" ? sessionId : null,
                  metadata: {
                    source: "layered_supervisor",
                    beatId: dreBeatId,
                  },
                });
                layeredInsightsInserted += 1;
              }
              const lmPayload = {
                phase: "supervisor" as const,
                sharedGoalCount: ex.nextShared.goals.length,
                privateNpcBuckets: Object.keys(ex.nextPrivate).length,
                insightsInserted: layeredInsightsInserted,
              };
              logTurnEvent(userId, sessionId, "layered_memory", lmPayload);
              controller.enqueue(
                encoder.encode(
                  toSse({
                    event: "layered_memory",
                    data: lmPayload,
                  })
                )
              );
            }

            const { state: stDre, keys: dreKeys } = mergeThreadSessionState(
              sessionId,
              userId,
              statePatch
            );
            mergedStateForPrompt = stDre;
            sessionStateHint = formatSessionStateForPrompt(stDre) ?? null;
            if (dreKeys.length > 0) {
              controller.enqueue(
                encoder.encode(
                  toSse({
                    event: "state_patched",
                    data: { keys: dreKeys, state: stDre },
                  })
                )
              );
              logTurnEvent(userId, sessionId, "state_patched", {
                keys: dreKeys,
                state: stDre,
                via: "dynamic_rp",
              });
            }

            if (isDreMemoryEnabled() && memoryStats !== null) {
              const memSt = parseDreMemoryFromSessionState(stDre);
              const memPayload = {
                addedFacts: memoryStats.addedFacts,
                newConflicts: memoryStats.newConflicts,
                totalEntries: memSt.entries.length,
                totalConflicts: memSt.conflicts.length,
              };
              logTurnEvent(userId, sessionId, "dre_memory", memPayload);
              controller.enqueue(
                encoder.encode(
                  toSse({
                    event: "dre_memory",
                    data: memPayload,
                  })
                )
              );
            }

            dreExtraSystemAppend =
              formatDynamicRpDirectorSystemAppend(bundle);
            if (dreWorldDirectorAppend.trim().length > 0) {
              dreExtraSystemAppend += `\n\n---\n\n${dreWorldDirectorAppend.trim()}`;
            }
            if (memoryDirectorAppend.length > 0) {
              dreExtraSystemAppend += `\n\n---\n\n${memoryDirectorAppend}`;
            }
          } else {
            dreExtraSystemAppend = DRE_DIALOGUE_MODE_APPEND;
            if (dreWorldDirectorAppend.trim().length > 0) {
              dreExtraSystemAppend += `\n\n---\n\n${dreWorldDirectorAppend.trim()}`;
            }
            if (isDreMemoryEnabled()) {
              const ro = formatDreMemoryDirectorAppend(
                parseDreMemoryFromSessionState(mergedStateForPrompt)
              );
              if (ro.trim().length > 0) {
                dreExtraSystemAppend += `\n\n---\n\n${ro.trim()}`;
              }
            }
            if (isLayeredMemoryEnabled() && !useMock) {
              const dLb = formatLayeredMemoryContextBlock({
                shared: parseSharedMemoryFromSessionState(mergedStateForPrompt),
                privateMap: parsePrivateMemoryFromSessionState(
                  mergedStateForPrompt
                ),
                insightRows: layeredInsightRows,
                activeNpcNames: getActiveNpcNamesFromSessionState(
                  mergedStateForPrompt
                ),
              });
              if (dLb) {
                dreExtraSystemAppend += `\n\n---\n\n${dLb}`;
              }
            }
            if (
              isLayeredMemoryEnabled() &&
              isLayeredMemoryDialogueExtractEnabled() &&
              !useMock
            ) {
              const priorS = parseSharedMemoryFromSessionState(
                mergedStateForPrompt
              );
              const priorP = parsePrivateMemoryFromSessionState(
                mergedStateForPrompt
              );
              const activeNpcsDlg = getActiveNpcNamesFromSessionState(
                mergedStateForPrompt
              );
              const ex = await runLayeredMemorySupervisorExtract({
                userLine: text,
                bundle: null,
                lastAssistantSnippet,
                priorShared: priorS,
                priorPrivate: priorP,
                activeNpcs: activeNpcsDlg,
                beatId: undefined,
                provider: thread.model_provider,
                modelId: thread.model_id,
              });
              let ins = 0;
              for (const c of ex.insightCandidates) {
                if (c.scope === "world" && !threadWorldId) continue;
                insertInsight({
                  id: randomUUID(),
                  userId,
                  summary: c.summary,
                  scope: c.scope,
                  worldId: c.scope === "world" ? threadWorldId : null,
                  threadId: c.scope === "session" ? sessionId : null,
                  metadata: { source: "layered_supervisor_dialogue" },
                });
                ins += 1;
              }
              const { state: stLm, keys: lmKeys } = mergeThreadSessionState(
                sessionId,
                userId,
                {
                  sharedMemory: sharedMemoryToPatchObject(ex.nextShared),
                  privateMemory: privateMemoryToPatchObject(ex.nextPrivate),
                }
              );
              mergedStateForPrompt = stLm;
              sessionStateHint = formatSessionStateForPrompt(stLm) ?? null;
              if (lmKeys.length > 0) {
                controller.enqueue(
                  encoder.encode(
                    toSse({
                      event: "state_patched",
                      data: { keys: lmKeys, state: stLm },
                    })
                  )
                );
                logTurnEvent(userId, sessionId, "state_patched", {
                  keys: lmKeys,
                  state: stLm,
                  via: "layered_memory_dialogue",
                });
              }
              const lmPayload = {
                phase: "supervisor" as const,
                sharedGoalCount: ex.nextShared.goals.length,
                privateNpcBuckets: Object.keys(ex.nextPrivate).length,
                insightsInserted: ins,
              };
              logTurnEvent(userId, sessionId, "layered_memory", lmPayload);
              controller.enqueue(
                encoder.encode(
                  toSse({
                    event: "layered_memory",
                    data: lmPayload,
                  })
                )
              );
            }
          }
        }

        let layeredPlainAppend: string | null = null;
        if (
          !isDynamicRpEngineEnabled() &&
          isLayeredMemoryEnabled() &&
          !useMock
        ) {
          layeredPlainAppend = formatLayeredMemoryContextBlock({
            shared: parseSharedMemoryFromSessionState(mergedStateForPrompt),
            privateMap: parsePrivateMemoryFromSessionState(
              mergedStateForPrompt
            ),
            insightRows: listInsightsForTavernContext({
              userId,
              threadId: sessionId,
              worldId: threadWorldId,
            }),
            activeNpcNames: getActiveNpcNamesFromSessionState(
              mergedStateForPrompt
            ),
          });
        }

        let mem0Append: string | null = null;
        if (isMem0Enabled()) {
          const rec = await searchMem0ForTurn({
            userId,
            threadId: sessionId,
            query: text,
          });
          mem0Append = rec.block;
          if (rec.rawCount > 0) {
            const mem0Payload = {
              hits: rec.rawCount,
              memories: rec.memories.map((m) =>
                m.length > 160 ? `${m.slice(0, 160)}…` : m
              ),
            };
            logTurnEvent(userId, sessionId, "mem0_context", mem0Payload);
            controller.enqueue(
              encoder.encode(
                toSse({
                  event: "mem0_context",
                  data: mem0Payload,
                })
              )
            );
          }
        }

        const allowWorldWrite = isAgentWorldWriteEnabled();
        let combinedExtraAppend: string | null = null;
        const drePart = dreExtraSystemAppend?.trim();
        if (drePart) {
          combinedExtraAppend = drePart;
        }
        if (layeredPlainAppend) {
          combinedExtraAppend = combinedExtraAppend
            ? `${layeredPlainAppend}\n\n---\n\n${combinedExtraAppend}`
            : layeredPlainAppend;
        }
        if (mem0Append) {
          combinedExtraAppend = combinedExtraAppend
            ? `${mem0Append}\n\n---\n\n${combinedExtraAppend}`
            : mem0Append;
        }
        if (useAgentToolsThisTurn) {
          const agentPart = buildAgentToolsSystemAppend({
            allowWorldWrite,
            reactCognitive: isReactCognitiveFrameworkEnabled(),
          });
          combinedExtraAppend = combinedExtraAppend
            ? `${combinedExtraAppend}\n\n---\n\n${agentPart}`
            : agentPart;
        }

        {
          const sp = TAVERN_SPEAKER_LINE_PROTOCOL.trim();
          combinedExtraAppend = combinedExtraAppend
            ? `${sp}\n\n---\n\n${combinedExtraAppend}`
            : sp;
        }

        const baseCompletionArgs = {
          provider: thread.model_provider,
          modelId: thread.model_id,
          messages: coreMessages,
          worldContext: worldContextBlock,
          sessionStateHint,
          ...(combinedExtraAppend
            ? { extraSystemAppend: combinedExtraAppend }
            : {}),
        };

        if (useAgentToolsThisTurn) {
          const reactOn = isReactCognitiveFrameworkEnabled();
          let reactStepBuffer = "";

          const dicePatchByToolCallId = new Map<
            string,
            { keys: string[]; state: Record<string, unknown> }
          >();

          const tools = buildTavernAgentTools({
            userId,
            allowWorldWrite,
            onAgentDiceSuccess: (toolCallId, result) => {
              const { state, keys } = mergeThreadSessionState(sessionId, userId, {
                lastDice: {
                  expression: result.expression,
                  total: result.total,
                  rolls: result.rolls,
                  at: new Date().toISOString(),
                },
              });
              dicePatchByToolCallId.set(toolCallId, { keys, state });
              logTurnEvent(userId, sessionId, "state_patched", {
                keys,
                state,
                via: "agent_tool_dice",
              });
            },
          });

          const result = streamTavernCompletion({
            ...baseCompletionArgs,
            tools,
            stopWhen: stepCountIs(getAgentMcpMaxSteps()),
          });

          for await (const part of result.fullStream) {
            if (part.type === "text-delta") {
              assistantText += part.text;
              if (reactOn) {
                reactStepBuffer += part.text;
              }
              controller.enqueue(
                encoder.encode(
                  toSse({
                    event: "token",
                    data: { delta: part.text },
                  })
                )
              );
              continue;
            }

            if (part.type === "tool-call") {
              if (reactOn) {
                const ex = extractThoughtBeforeToolCall(reactStepBuffer);
                const thoughtPayload = {
                  toolName: part.toolName,
                  toolCallId: part.toolCallId,
                  thought: ex.thought,
                  compliant: ex.compliant,
                  ...(ex.compliant
                    ? {}
                    : { precedingTail: ex.precedingTail }),
                };
                logTurnEvent(userId, sessionId, "react_thought", thoughtPayload);
                controller.enqueue(
                  encoder.encode(
                    toSse({
                      event: "react_thought",
                      data: thoughtPayload,
                    })
                  )
                );
                reactStepBuffer = "";
              }
              logTurnEvent(userId, sessionId, "agent_tool_call", {
                toolName: part.toolName,
                toolCallId: part.toolCallId,
                input: part.input,
              });
              controller.enqueue(
                encoder.encode(
                  toSse({
                    event: "tool_called",
                    data: {
                      source: "agent",
                      toolName: part.toolName,
                      toolCallId: part.toolCallId,
                      input: part.input,
                    },
                  })
                )
              );
              continue;
            }

            if (part.type === "tool-result") {
              const patch = dicePatchByToolCallId.get(part.toolCallId);
              if (patch && part.toolName === "dice_roll") {
                controller.enqueue(
                  encoder.encode(
                    toSse({ event: "state_patched", data: patch })
                  )
                );
                dicePatchByToolCallId.delete(part.toolCallId);
              }

              if (reactOn) {
                const preview =
                  part.toolName === "dice_roll"
                    ? truncateJsonForSse(part.output as DiceRollResult, 1200)
                    : truncateJsonForSse(part.output, 1200);
                const obsPayload = {
                  toolName: part.toolName,
                  toolCallId: part.toolCallId,
                  preview,
                  ok: true as const,
                };
                logTurnEvent(userId, sessionId, "react_observation", obsPayload);
                controller.enqueue(
                  encoder.encode(
                    toSse({
                      event: "react_observation",
                      data: obsPayload,
                    })
                  )
                );
              }

              let diceMeta: Record<string, unknown> | undefined;
              if (part.toolName === "dice_roll") {
                diceMeta = diceToolPayload(part.output as DiceRollResult, {
                  transport: isMcpDiceEnabled() ? "mcp_stdio" : "inline",
                  source: "agent",
                  toolCallId: part.toolCallId,
                });
              }

              logTurnEvent(userId, sessionId, "agent_tool_finished", {
                toolName: part.toolName,
                toolCallId: part.toolCallId,
                ok: true,
                ...(diceMeta ? { dice: diceMeta } : {}),
                ...(part.toolName === "dice_roll"
                  ? {}
                  : {
                      outputPreview: truncateJsonForSse(part.output, 4000),
                    }),
              });

              controller.enqueue(
                encoder.encode(
                  toSse({
                    event: "agent_tool_finished",
                    data: {
                      toolName: part.toolName,
                      toolCallId: part.toolCallId,
                      ok: true,
                      ...(diceMeta ? { dice: diceMeta } : {}),
                      ...(part.toolName === "dice_roll"
                        ? {}
                        : {
                            outputPreview: truncateJsonForSse(
                              part.output,
                              4000
                            ),
                          }),
                    },
                  })
                )
              );
              continue;
            }

            if (part.type === "tool-error") {
              const errMsg =
                part.error instanceof Error
                  ? part.error.message
                  : String(part.error);
              if (reactOn) {
                const obsPayload = {
                  toolName: part.toolName,
                  toolCallId: part.toolCallId,
                  preview: "",
                  ok: false as const,
                  error: errMsg,
                };
                logTurnEvent(userId, sessionId, "react_observation", obsPayload);
                controller.enqueue(
                  encoder.encode(
                    toSse({
                      event: "react_observation",
                      data: obsPayload,
                    })
                  )
                );
              }
              logTurnEvent(userId, sessionId, "agent_tool_finished", {
                toolName: part.toolName,
                toolCallId: part.toolCallId,
                ok: false,
                error: errMsg,
              });
              controller.enqueue(
                encoder.encode(
                  toSse({
                    event: "agent_tool_finished",
                    data: {
                      toolName: part.toolName,
                      toolCallId: part.toolCallId,
                      ok: false,
                      error: errMsg,
                    },
                  })
                )
              );
              continue;
            }

            if (part.type === "error") {
              throw part.error;
            }
          }
        } else {
          const result = streamTavernCompletion(baseCompletionArgs);

          for await (const delta of result.textStream) {
            assistantText += delta;
            controller.enqueue(
              encoder.encode(
                toSse({
                  event: "token",
                  data: { delta },
                })
              )
            );
          }
        }

        let finalizedAssistantText = assistantText || " ";
        if (usedActionTurn) {
          const runtimeActionSpeakers = mergeRuntimeSpeakerCandidates({
            seed: actionTurnSpeakers,
            texts: [text, lastAssistantSnippet, finalizedAssistantText],
          });
          const runtimeActionPreferred =
            addressedSpeaker ||
            pickAddressedSpeaker(text, runtimeActionSpeakers) ||
            pickAddressedSpeaker(finalizedAssistantText, runtimeActionSpeakers) ||
            runtimeActionSpeakers[0] ||
            null;
          const hasParseableDreScenePackage =
            /\[CW_SCENE\]/.test(finalizedAssistantText) &&
            /\[CW_VOICE:[^\]]+\]/.test(finalizedAssistantText);
          // 已经是前端可解析的场景包，就不要再兜底重排，否则会破坏 [CW_SCENE]/[CW_VOICE] 结构。
          finalizedAssistantText = hasParseableDreScenePackage
            ? finalizedAssistantText
            : await ensureGroupSpeakerMarkers({
                text: finalizedAssistantText,
                speakers: runtimeActionSpeakers,
                preferredSpeaker: runtimeActionPreferred,
                forceIncludePreferred: Boolean(runtimeActionPreferred),
                strictNameHeader: dreStrictGroupFormat,
                provider: thread.model_provider,
                modelId: thread.model_id,
              });
          formatReviewSpeakers = runtimeActionSpeakers;
          formatReviewPreferred = runtimeActionPreferred;
        } else {
          const dialogueSpeakerPool = mergeRuntimeSpeakerCandidates({
            seed: getActiveNpcNamesFromSessionState(mergedStateForPrompt),
            // 用户文本不做宽松抽取，避免把“天之骄子”等自述短语误识别成人名
            texts: [lastAssistantSnippet, finalizedAssistantText],
          });
          const primary = assistantRow?.name?.trim();
          if (primary && isLikelyCharacterName(primary) && !dialogueSpeakerPool.includes(primary)) {
            dialogueSpeakerPool.push(primary);
          }
          for (const n of extractAddressedNamesFromUserText(text)) {
            if (!dialogueSpeakerPool.includes(n)) dialogueSpeakerPool.push(n);
          }
          addressedSpeaker = pickAddressedSpeaker(text, dialogueSpeakerPool);
          const dialoguePreferred =
            addressedSpeaker ||
            pickAddressedSpeaker(finalizedAssistantText, dialogueSpeakerPool) ||
            dialogueSpeakerPool[0] ||
            null;
          const hasNamedRoleBlock = /(^|\n)\s*【(?!\s*场景\s*】)[^】\n]{1,24}】\s*(\n|$)/.test(
            finalizedAssistantText
          );
          // 原文已有角色块时，优先保留原始角色名（如“杨砚”），避免被点名称呼（如“老杨”）重写。
          // 或者候选池为空时，也不做破坏性重排。
          if (dialogueSpeakerPool.length === 0 || hasNamedRoleBlock) {
            finalizedAssistantText = finalizedAssistantText;
          } else {
            finalizedAssistantText = await ensureGroupSpeakerMarkers({
              text: finalizedAssistantText,
              speakers: dialogueSpeakerPool,
              preferredSpeaker: dialoguePreferred,
              forceIncludePreferred: Boolean(dialoguePreferred),
              strictNameHeader: dreStrictGroupFormat,
              provider: thread.model_provider,
              modelId: thread.model_id,
            });
          }
          formatReviewSpeakers = dialogueSpeakerPool;
          formatReviewPreferred = dialoguePreferred;
        }
        // 严格格式审查不应依赖 DRE 开关：无论是否启用 DRE，只要开启严格模式都执行。
        if (dreStrictGroupFormat) {
          finalizedAssistantText = await auditAndRepairRoleBlockFormat({
            text: finalizedAssistantText,
            speakers: formatReviewSpeakers,
            preferredSpeaker: formatReviewPreferred,
            disallowScene: false,
            provider: thread.model_provider,
            modelId: thread.model_id,
          });
        }
        const fin = formatAssistantMessageForPersistence(finalizedAssistantText);

        logTurnEvent(userId, sessionId, "turn_finished", {
          assistantChars: finalizedAssistantText.length,
          speakerLabel: fin.speakerLabel,
        });

        controller.enqueue(
          encoder.encode(
            toSse({
              event: "turn_finished",
              data: {
                sessionId,
                message: finalizedAssistantText,
                displayMessage: fin.content,
                speakerLabel: fin.speakerLabel,
              },
            })
          )
        );

        insertMessage({
          id: randomUUID(),
          threadId: sessionId,
          role: "assistant",
          content: fin.content,
          speakerLabel: fin.speakerLabel,
        });

        if (!isAutoTurn && isMem0Enabled() && fin.content.trim()) {
          void ingestMem0Turn({
            userId,
            threadId: sessionId,
            userText: text,
            assistantText: fin.content,
            worldVersionId: thread.world_version_id,
          }).then((r) => {
            if (r.ok) {
              logTurnEvent(userId, sessionId, "mem0_ingest_ok", {});
            } else if (
              r.error &&
              r.error !== "mem0_unavailable" &&
              r.error !== "empty_turn"
            ) {
              logTurnEvent(userId, sessionId, "mem0_ingest_failed", {
                error: r.error,
              });
            }
          });
        }
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "模型调用失败，请稍后重试。";
        logTurnEvent(userId, sessionId, "error", { message });
        controller.enqueue(
          encoder.encode(
            toSse({
              event: "error",
              data: { message },
            })
          )
        );
        const finErr = formatAssistantMessageForPersistence(assistantText || " ");
        controller.enqueue(
          encoder.encode(
            toSse({
              event: "turn_finished",
              data: {
                sessionId,
                message: assistantText,
                displayMessage: finErr.content,
                speakerLabel: finErr.speakerLabel,
              },
            })
          )
        );
        if (assistantText.trim()) {
          insertMessage({
            id: randomUUID(),
            threadId: sessionId,
            role: "assistant",
            content: finErr.content,
            speakerLabel: finErr.speakerLabel,
          });
          if (!isAutoTurn && isMem0Enabled()) {
            void ingestMem0Turn({
              userId,
              threadId: sessionId,
              userText: text,
              assistantText: finErr.content,
              worldVersionId: thread.world_version_id,
            }).then((r) => {
              if (r.ok) {
                logTurnEvent(userId, sessionId, "mem0_ingest_ok", {});
              } else if (
                r.error &&
                r.error !== "mem0_unavailable" &&
                r.error !== "empty_turn"
              ) {
                logTurnEvent(userId, sessionId, "mem0_ingest_failed", {
                  error: r.error,
                });
              }
            });
          }
        }
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
