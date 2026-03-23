"use client";

import Link from "next/link";
import { FormEvent, type CSSProperties, useEffect, useMemo, useRef, useState } from "react";

type AgentTraceEntry =
  | {
      kind: "call";
      toolName: string;
      toolCallId: string;
      inputSummary: string;
    }
  | {
      kind: "done";
      toolName: string;
      toolCallId: string;
      ok: boolean;
      summary: string;
    };

type ReactTraceEntry =
  | {
      kind: "thought";
      toolName: string;
      text: string | null;
      compliant: boolean;
    }
  | {
      kind: "observation";
      toolName: string;
      preview: string;
      ok: boolean;
      error?: string;
    };

type Message = {
  role: "user" | "assistant";
  content: string;
  /** 本回合助手气泡旁名字（模型 [CW_SPEAKER:…] 解析结果） */
  speakerLabel?: string;
  agentTrace?: AgentTraceEntry[];
  /** 动态扮演引擎（DRE）本回合轨迹，供折叠展示 */
  dreTrace?: string[];
  /** ReAct：Thought / Observation 与工具交错 */
  reactTrace?: ReactTraceEntry[];
};

type ChatPanelProps = {
  sessionId: string;
  initialMessages: Message[];
  initialModel: {
    provider: string;
    modelId: string;
  };
  initialWorldVersionId: string | null;
  /** personas.id，可为空 */
  initialPersonaId: string | null;
  /** 匹配 canonical.character_books，可为空 */
  initialActiveCharacterBoundEntityId: string | null;
  /** AI 酒馆角色 tavern_characters.id */
  initialAssistantCharacterId: string | null;
  /** 服务端已解析的角色显示名，避免首屏在列表加载前闪「角色」 */
  initialAssistantCharacterName?: string | null;
  initialSessionState: Record<string, unknown>;
  /** 服务端 CW_AGENT_MCP（用于 UI 提示） */
  agentMcpConfigured: boolean;
  /** 服务端 CW_CHAT_MOCK */
  chatMockConfigured: boolean;
  /** 服务端 CW_DYNAMIC_RP_ENGINE */
  dynamicRpConfigured: boolean;
  /** 服务端 CW_DRE_INTENT_LLM：off | hybrid | full */
  dreIntentLlmMode: "off" | "hybrid" | "full";
  /** 服务端 CW_DRE_A2A_ROUNDS（1~4） */
  dreA2aInteractionRounds: number;
  /** 是否配置 CW_DRE_A2A_REDIS_URL */
  dreA2aRedisConfigured: boolean;
  /** 服务端 CW_DRE_MEMORY */
  dreMemoryConfigured: boolean;
  /** 服务端 CW_DRE_WORLD_ENTITIES（需绑定世界版本） */
  dreWorldEntitiesConfigured: boolean;
  /** 服务端 CW_REACT_FRAMEWORK（需 CW_AGENT_MCP） */
  reactFrameworkConfigured: boolean;
};

type WorldWithVersions = {
  id: string;
  name: string;
  versions: Array<{ id: string; version: number; created_at: string }>;
};

type PersonaRow = {
  id: string;
  name: string;
  description: string;
  title: string | null;
};

type CharacterBookOptionRow = { bound_entity_id: string; label: string };

type TavernCharacterRow = { id: string; name: string; tags: string };

type SseEvent = {
  eventName: string;
  rawData: string;
};

type SessionEventRow = {
  id: string;
  eventType: string;
  payload: Record<string, unknown>;
  createdAt: string;
};

function parseSseBlocks(chunkText: string): { events: SseEvent[]; rest: string } {
  const blocks = chunkText.split("\n\n");
  const rest = blocks.pop() ?? "";
  const events: SseEvent[] = [];

  for (const block of blocks) {
    if (!block.trim()) continue;
    const lines = block.split("\n");
    let eventName = "message";
    const dataParts: string[] = [];

    for (const line of lines) {
      if (line.startsWith("event:")) {
        eventName = line.slice("event:".length).trim();
      } else if (line.startsWith("data:")) {
        dataParts.push(line.slice("data:".length).trim());
      }
    }

    events.push({ eventName, rawData: dataParts.join("\n") });
  }

  return { events, rest };
}

function summarizeAgentToolInput(toolName: string, input: unknown): string {
  if (input === null || input === undefined) return "";
  if (typeof input !== "object") return String(input);
  const o = input as Record<string, unknown>;
  if (toolName === "dice_roll") {
    return String(o.expression ?? "");
  }
  if (toolName === "world_reader") {
    const op = String(o.operation ?? "?");
    const wid =
      typeof o.world_id === "string" ? o.world_id.slice(0, 8) + "…" : "";
    const vid =
      typeof o.version_id === "string" ? o.version_id.slice(0, 8) + "…" : "";
    return [op, wid || vid].filter(Boolean).join(" · ");
  }
  if (toolName === "world_writer") {
    const op = String(o.operation ?? "?");
    return op;
  }
  try {
    const s = JSON.stringify(input);
    return s.length > 160 ? `${s.slice(0, 160)}…` : s;
  } catch {
    return "";
  }
}

function formatAgentToolFinishedSummary(data: {
  toolName: string;
  ok: boolean;
  dice?: Record<string, unknown>;
  outputPreview?: string;
  error?: string;
}): string {
  if (!data.ok) {
    return `失败：${data.error ?? "unknown"}`;
  }
  if (data.toolName === "dice_roll" && data.dice) {
    const inp = data.dice.input as { expression?: string } | undefined;
    const out = data.dice.output as
      | { rolls?: number[]; total?: number }
      | undefined;
    if (out && Array.isArray(out.rolls)) {
      return `${inp?.expression ?? "?"} → [${out.rolls.join(", ")}] 合计 ${out.total ?? "?"}`;
    }
  }
  if (data.outputPreview) {
    return data.outputPreview.length > 280
      ? `${data.outputPreview.slice(0, 280)}…`
      : data.outputPreview;
  }
  return "完成";
}

type SceneVoice = { speaker: string; line: string };

type ParsedScenePackage = {
  scene: string;
  voices: SceneVoice[];
  wrap: string;
};

type ParsedTranscriptSection = { speaker: string; content: string };

function isLikelySpeakerName(name: string): boolean {
  const n = name.trim();
  if (!n) return false;
  if (n === "场景") return true;
  if (n.length < 2 || n.length > 6) return false;
  if (!/^[A-Za-z\u4e00-\u9fa5·]+$/.test(n)) return false;
  if (/(场景|旁白|日志|条目|记录|补充|章节|目录|系统)/.test(n)) return false;
  // 过滤时间/章节/路线等标签，避免「廷根时期」被误当角色名
  if (/(时期|时代|阶段|年间|纪元|线|篇|卷|章|幕|节)$/.test(n)) return false;
  if (/^场景\s*NPC/.test(n)) return false;
  const badStarts = [
    "抬",
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
  ];
  if (badStarts.some((x) => n.startsWith(x))) return false;
  return true;
}

function normalizeSceneBracketNarration(content: string): string {
  const lines = content.split("\n");
  const normalized = lines.map((line) => {
    const t = line.trim();
    const m = t.match(/^[【\[]([^】\]\n]{2,48})[】\]]$/);
    if (!m) return line;
    const inner = m[1]?.trim() ?? "";
    // 只清洗动作/状态短句，避免误伤真正的角色段头。
    if (!inner || isLikelySpeakerName(inner)) return line;
    return line.replace(t, inner);
  });
  return normalized.join("\n");
}

function stripLeadingNonSpeakerTag(content: string): string {
  const lines = content.split("\n");
  if (lines.length === 0) return content;
  const first = lines[0]?.trim() ?? "";
  const m = first.match(/^[【\[]([^】\]\n]{2,24})[】\]]$/);
  if (!m) return content;
  const inner = (m[1] ?? "").trim();
  if (!inner) return content;
  // 去掉“时代/章节/路线”类标签，避免污染角色正文（如【廷根时期】）。
  if (/(时期|时代|阶段|年间|纪元|线|篇|卷|章|幕|节)$/.test(inner)) {
    const rest = lines.slice(1).join("\n").trim();
    return rest || content;
  }
  if (!isLikelySpeakerName(inner)) {
    const rest = lines.slice(1).join("\n").trim();
    return rest || content;
  }
  return content;
}

function hashSpeakerName(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) {
    h = (h * 31 + name.charCodeAt(i)) >>> 0;
  }
  return h;
}

function getSpeakerVisual(name: string): {
  roleStyle?: CSSProperties;
  bodyStyle?: CSSProperties;
} {
  const n = name.trim();
  if (!n || n === "场景") {
    return {
      roleStyle: { color: "var(--muted)" },
      bodyStyle: {
        borderLeft: "2px solid rgba(255,255,255,0.14)",
      },
    };
  }
  const h = hashSpeakerName(n) % 360;
  return {
    roleStyle: { color: `hsl(${h} 72% 68%)` },
    bodyStyle: {
      borderLeft: `3px solid hsl(${h} 62% 54% / 0.88)`,
      background: `linear-gradient(0deg, hsl(${h} 40% 18% / 0.22), hsl(${h} 40% 18% / 0.22)), var(--bg-elev, rgba(255,255,255,0.02))`,
    },
  };
}

function parseScenePackage(content: string): ParsedScenePackage | null {
  const lines = content.split("\n");
  let i = 0;
  while (i < lines.length && lines[i].trim().length === 0) i += 1;
  if (i >= lines.length || lines[i].trim() !== "[CW_SCENE]") {
    return null;
  }

  i += 1;
  const sceneLines: string[] = [];
  const voices: SceneVoice[] = [];
  const wrapLines: string[] = [];
  let inWrap = false;

  for (; i < lines.length; i++) {
    const line = lines[i];
    const t = line.trim();
    if (t === "[CW_WRAP]") {
      inWrap = true;
      continue;
    }
    const vm = t.match(/^\[CW_VOICE:([^\]\n]+)\]\s*(.*)$/);
    if (vm && !inWrap) {
      const speaker = vm[1].trim().slice(0, 64);
      const body = vm[2].trim();
      if (speaker && body) {
        voices.push({ speaker, line: body });
      }
      continue;
    }
    if (inWrap) {
      wrapLines.push(line);
    } else {
      sceneLines.push(line);
    }
  }

  const scene = sceneLines.join("\n").trim();
  const wrap = wrapLines.join("\n").trim();
  if (!scene || voices.length === 0 || !wrap) {
    return null;
  }
  return { scene, voices, wrap };
}

/**
 * 兜底解析：把类似
 * 【雷蒙】
 * 台词...
 * 【苏行】
 * 台词...
 * 的文本拆成多说话人段落；未标注段落归入「场景」。
 */
function parseBracketSpeakerTranscript(content: string): ParsedTranscriptSection[] | null {
  const lines = content.split("\n");
  const sections: ParsedTranscriptSection[] = [];
  let currentSpeaker = "场景";
  let bucket: string[] = [];
  let seenSpeakerMarker = false;

  const flush = () => {
    const txt = bucket.join("\n").trim();
    if (txt) sections.push({ speaker: currentSpeaker, content: txt });
    bucket = [];
  };

  for (const raw of lines) {
    const t = raw.trim();
    const onlyMarker = t.match(/^[【\[]([^】\]\n]{1,24})[】\]]\s*$/);
    if (onlyMarker) {
      const nextSpeaker = onlyMarker[1].trim();
      if (!isLikelySpeakerName(nextSpeaker)) {
        bucket.push(raw);
        continue;
      }
      seenSpeakerMarker = true;
      flush();
      currentSpeaker = nextSpeaker || "场景";
      continue;
    }
    const markerWithLine = t.match(/^[【\[]([^】\]\n]{1,24})[】\]]\s*(.+)$/);
    if (markerWithLine) {
      const nextSpeaker = markerWithLine[1].trim();
      if (!isLikelySpeakerName(nextSpeaker)) {
        bucket.push(raw);
        continue;
      }
      seenSpeakerMarker = true;
      flush();
      currentSpeaker = nextSpeaker || "场景";
      bucket.push(markerWithLine[2]);
      continue;
    }
    const m = t.match(/^【([^】\n]{1,24})】\s*$/);
    if (m) {
      const nextSpeaker = m[1].trim();
      if (!isLikelySpeakerName(nextSpeaker)) {
        bucket.push(raw);
        continue;
      }
      seenSpeakerMarker = true;
      flush();
      currentSpeaker = nextSpeaker || "场景";
      continue;
    }
    bucket.push(raw);
  }
  flush();

  if (!seenSpeakerMarker || sections.length === 0) {
    return null;
  }
  // 允许“只有一个说话者分段”的情况；但如果全是「场景」就不拆。
  const hasNamed = sections.some((s) => s.speaker !== "场景" && isLikelySpeakerName(s.speaker));
  if (!hasNamed) {
    return null;
  }
  return sections;
}

function parseInlineSpeakerTranscript(content: string): ParsedTranscriptSection[] | null {
  const lines = content.split("\n");
  const sections: ParsedTranscriptSection[] = [];
  const sceneBucket: string[] = [];
  const badNames = new Set([
    "你",
    "我",
    "他",
    "她",
    "它",
    "大家",
    "有人",
    "场景",
    "旁白",
    "记录",
    "然后",
    "但是",
    "所以",
    "如果",
    "日志",
    "条目",
    "注释",
    "系统",
  ]);

  const looksLikeSectionTitle = (name: string): boolean => {
    if (name.length > 8) return true;
    if (/[《》]/.test(name)) return true;
    if (name.includes("·") && name.length > 6) return true;
    if (/(日志|条目|注释|系统|设定|补充|章节|目录)$/.test(name)) return true;
    return false;
  };

  const flushScene = () => {
    const t = sceneBucket.join("\n").trim();
    if (t) sections.push({ speaker: "场景", content: t });
    sceneBucket.length = 0;
  };

  let seenSpeaker = false;
  for (const line of lines) {
    const re = /([A-Za-z\u4e00-\u9fa5·]{2,12})[：:]/g;
    const marks: Array<{ name: string; at: number; end: number }> = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(line)) !== null) {
      const name = m[1].trim();
      if (
        !name ||
        badNames.has(name) ||
        looksLikeSectionTitle(name) ||
        !isLikelySpeakerName(name)
      ) {
        continue;
      }
      marks.push({ name, at: m.index, end: re.lastIndex });
    }
    if (marks.length === 0) {
      sceneBucket.push(line);
      continue;
    }
    seenSpeaker = true;
    const first = marks[0]!;
    const pre = line.slice(0, first.at).trim();
    if (pre) {
      sceneBucket.push(pre);
    }
    flushScene();
    for (let i = 0; i < marks.length; i++) {
      const cur = marks[i]!;
      const next = marks[i + 1];
      const body = line
        .slice(cur.end, next ? next.at : line.length)
        .trim();
      if (body) {
        sections.push({ speaker: cur.name, content: body });
      }
    }
  }
  flushScene();
  if (!seenSpeaker || sections.length < 2) return null;
  return sections;
}

function parseParentheticalSpeakerTranscript(
  content: string
): ParsedTranscriptSection[] | null {
  const lines = content.split("\n");
  const sections: ParsedTranscriptSection[] = [];
  const sceneBucket: string[] = [];
  let activeSpeaker: string | null = null;
  let activeBucket: string[] = [];
  const badNames = new Set([
    "你",
    "我",
    "他",
    "她",
    "它",
    "大家",
    "有人",
    "场景",
    "旁白",
    "记录",
    "然后",
    "但是",
    "所以",
    "如果",
  ]);
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
  ];

  const flushScene = () => {
    const t = sceneBucket.join("\n").trim();
    if (t) sections.push({ speaker: "场景", content: t });
    sceneBucket.length = 0;
  };

  const flushActiveSpeaker = () => {
    if (!activeSpeaker) return;
    const t = activeBucket.join("\n").trim();
    if (t) sections.push({ speaker: activeSpeaker, content: t });
    activeBucket = [];
    activeSpeaker = null;
  };

  const looksLikeSpeakerContinuation = (rawLine: string): boolean => {
    const t = rawLine.trim();
    if (!t) return false;
    if (/^[（(].+[）)]$/.test(t) && !/^[（(]\s*[A-Za-z\u4e00-\u9fa5·]{2,12}/.test(t)) {
      return true;
    }
    if (/^[“"「『《]/.test(t)) return true;
    if (/^(啊|诶|欸|嗯|哎|唉|哈|嘿|喂|你|我|他|她|它)/.test(t)) return true;
    if (/^[^：:\n]{1,18}[：:]/.test(t)) return true;
    return false;
  };

  let seen = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^[（(]\s*([A-Za-z\u4e00-\u9fa5·]{2,12})[^）)]*[）)]\s*(.*)$/);
    if (!m) {
      if (activeSpeaker && looksLikeSpeakerContinuation(raw)) {
        activeBucket.push(raw);
      } else {
        flushActiveSpeaker();
        sceneBucket.push(raw);
      }
      continue;
    }
    const name = m[1].trim();
    if (!name || badNames.has(name) || badNameStarts.some((ch) => name.startsWith(ch))) {
      sceneBucket.push(raw);
      continue;
    }
    if (!isLikelySpeakerName(name)) {
      sceneBucket.push(raw);
      continue;
    }
    seen = true;
    flushActiveSpeaker();
    flushScene();
    activeSpeaker = name;
    activeBucket.push(line);
  }
  flushActiveSpeaker();
  flushScene();

  if (!seen || sections.length < 2) return null;
  return sections;
}

function expandAssistantSceneToGroupMessages(base: Message): Message[] {
  if (base.role !== "assistant") return [base];
  // 服务端已通过 [CW_SPEAKER]/【说话者：...】提取了主说话者时，
  // 这条消息应保持单气泡，避免把动作括号行误拆成“新说话者”。
  const hasRoleHeaderInContent = /(^|\n)\s*【[^】\n]{1,24}】\s*(\n|$)/.test(
    base.content
  );
  if (
    base.speakerLabel?.trim() &&
    base.speakerLabel.trim() !== "场景" &&
    !hasRoleHeaderInContent
  ) {
    return [{ ...base, content: stripLeadingNonSpeakerTag(base.content) }];
  }
  const parsed = parseScenePackage(base.content);
  if (!parsed) {
    const fallback = parseBracketSpeakerTranscript(base.content);
    // 不再优先使用“括号动作句”推断说话者，避免把「停下脚步/微微点头」误识别成人名。
    const inline = fallback ?? parseInlineSpeakerTranscript(base.content);
    if (!inline) return [{ ...base, content: stripLeadingNonSpeakerTag(base.content) }];
    return inline.map((s) => ({
      role: "assistant",
      speakerLabel: s.speaker,
      content:
        s.speaker === "场景"
          ? normalizeSceneBracketNarration(s.content)
          : s.content,
    }));
  }

  const out: Message[] = [];
  out.push({
    ...base,
    speakerLabel: "场景",
    content: normalizeSceneBracketNarration(parsed.scene),
  });
  for (const v of parsed.voices) {
    out.push({
      role: "assistant",
      speakerLabel: v.speaker,
      content: v.line,
    });
  }
  out.push({
    role: "assistant",
    speakerLabel: "场景",
    content: normalizeSceneBracketNarration(parsed.wrap),
  });
  return out;
}

export default function ChatPanel({
  sessionId,
  initialMessages,
  initialModel,
  initialWorldVersionId,
  initialPersonaId,
  initialActiveCharacterBoundEntityId,
  initialAssistantCharacterId,
  initialAssistantCharacterName = null,
  initialSessionState,
  agentMcpConfigured,
  chatMockConfigured,
  dynamicRpConfigured,
  dreIntentLlmMode,
  dreA2aInteractionRounds,
  dreA2aRedisConfigured,
  dreMemoryConfigured,
  dreWorldEntitiesConfigured,
  reactFrameworkConfigured,
}: ChatPanelProps) {
  const [input, setInput] = useState("");
  // 首屏/回访时，后端会把 speaker 相关信息（可能被剥离到 speakerLabel）存起来；
  // 但初次渲染需要同样的“群像拆分”逻辑，否则会把 [角色名] 段落留在同一条正文气泡里。
  const [messages, setMessages] = useState<Message[]>(() =>
    initialMessages.flatMap((m) => expandAssistantSceneToGroupMessages(m))
  );
  const [isStreaming, setIsStreaming] = useState(false);
  const [status, setStatus] = useState("就绪");
  const [modelOptions, setModelOptions] = useState<
    Array<{ provider: string; modelId: string; label: string }>
  >([]);
  const [selectedModel, setSelectedModel] = useState(
    `${initialModel.provider}::${initialModel.modelId}`
  );
  const [modelStatus, setModelStatus] = useState("加载模型列表…");
  const [worldsWithVersions, setWorldsWithVersions] = useState<WorldWithVersions[]>([]);
  const [worldLoadStatus, setWorldLoadStatus] = useState("加载世界中…");
  const [boundWorldVersionId, setBoundWorldVersionId] = useState(
    initialWorldVersionId ?? ""
  );
  const [worldBindStatus, setWorldBindStatus] = useState("");
  const [personas, setPersonas] = useState<PersonaRow[]>([]);
  const [characterOptions, setCharacterOptions] = useState<CharacterBookOptionRow[]>(
    []
  );
  const [selectedPersonaId, setSelectedPersonaId] = useState(
    initialPersonaId ?? ""
  );
  const [selectedCharacterId, setSelectedCharacterId] = useState(
    initialActiveCharacterBoundEntityId ?? ""
  );
  const [tavernCharacters, setTavernCharacters] = useState<TavernCharacterRow[]>(
    []
  );
  const [selectedAssistantCharacterId, setSelectedAssistantCharacterId] =
    useState(initialAssistantCharacterId ?? "");
  const [rpBindStatus, setRpBindStatus] = useState("");
  const [newPersonaName, setNewPersonaName] = useState("");
  const [sessionEvents, setSessionEvents] = useState<SessionEventRow[]>([]);
  const [eventsLoadStatus, setEventsLoadStatus] = useState("");
  const [sessionState, setSessionState] =
    useState<Record<string, unknown>>(initialSessionState);

  const firstMesAutoSeedAttempted = useRef(false);
  const sendFormRef = useRef<HTMLFormElement | null>(null);
  const autoPilotLastAtRef = useRef<number>(0);
  const [autoPilotEnabled, setAutoPilotEnabled] = useState(false);
  const [autoPilotIntervalSec, setAutoPilotIntervalSec] = useState(18);
  const [autoPilotProfile, setAutoPilotProfile] = useState<
    "conservative" | "standard" | "aggressive"
  >("standard");
  const [simpleUiMode, setSimpleUiMode] = useState(true);

  const canSend = useMemo(
    () => input.trim().length > 0 && !isStreaming,
    [input, isStreaming]
  );

  /** 助手侧气泡、标题、占位符：有绑定角色库时用角色名，否则用中性「场景」 */
  const assistantDisplayLabel = useMemo(() => {
    const id = selectedAssistantCharacterId.trim();
    if (!id) {
      return "场景";
    }
    const row = tavernCharacters.find((c) => c.id === id);
    const fromList = row?.name?.trim();
    if (fromList) {
      return fromList;
    }
    if (
      id === (initialAssistantCharacterId ?? "").trim() &&
      initialAssistantCharacterName?.trim()
    ) {
      return initialAssistantCharacterName.trim();
    }
    return "角色";
  }, [
    selectedAssistantCharacterId,
    tavernCharacters,
    initialAssistantCharacterId,
    initialAssistantCharacterName,
  ]);

  useEffect(() => {
    async function loadModels() {
      const response = await fetch("/api/models");
      if (!response.ok) {
        setModelStatus("模型列表加载失败。");
        return;
      }

      const payload = (await response.json()) as {
        models: Array<{ provider: string; modelId: string; label: string }>;
      };

      setModelOptions(payload.models);
      const currentValue = `${initialModel.provider}::${initialModel.modelId}`;
      const hasCurrent = payload.models.some(
        (item) => `${item.provider}::${item.modelId}` === currentValue
      );
      if (hasCurrent) {
        setSelectedModel(currentValue);
      } else if (payload.models[0]) {
        setSelectedModel(`${payload.models[0].provider}::${payload.models[0].modelId}`);
      }
      setModelStatus("模型已就绪");
    }

    loadModels().catch(() => {
      setModelStatus("模型列表加载失败。");
    });
  }, [initialModel.modelId, initialModel.provider]);

  useEffect(() => {
    setBoundWorldVersionId(initialWorldVersionId ?? "");
  }, [initialWorldVersionId, sessionId]);

  useEffect(() => {
    setSelectedPersonaId(initialPersonaId ?? "");
    setSelectedCharacterId(initialActiveCharacterBoundEntityId ?? "");
    setSelectedAssistantCharacterId(initialAssistantCharacterId ?? "");
  }, [
    sessionId,
    initialPersonaId,
    initialActiveCharacterBoundEntityId,
    initialAssistantCharacterId,
  ]);

  useEffect(() => {
    let cancelled = false;
    async function loadRpBindings() {
      const response = await fetch(`/api/threads/${sessionId}/rp-bindings`);
      if (cancelled) return;
      if (!response.ok) {
        setRpBindStatus("人格/角色列表加载失败");
        return;
      }
      const payload = (await response.json()) as {
        personas?: PersonaRow[];
        tavernCharacters?: TavernCharacterRow[];
        characterOptions?: CharacterBookOptionRow[];
        thread?: {
          personaId?: string | null;
          activeCharacterBoundEntityId?: string | null;
          assistantCharacterId?: string | null;
        };
      };
      setPersonas(payload.personas ?? []);
      setTavernCharacters(payload.tavernCharacters ?? []);
      setCharacterOptions(payload.characterOptions ?? []);
      if (payload.thread) {
        setSelectedPersonaId(payload.thread.personaId ?? "");
        setSelectedCharacterId(payload.thread.activeCharacterBoundEntityId ?? "");
        setSelectedAssistantCharacterId(payload.thread.assistantCharacterId ?? "");
      }
      setRpBindStatus("");
    }
    void loadRpBindings();
    return () => {
      cancelled = true;
    };
  }, [sessionId, boundWorldVersionId]);

  /** 空会话 + 已绑定 AI 角色：尝试插入 first_mes（与 SSR 页面上逻辑一致，覆盖客户端绑定角色等场景） */
  useEffect(() => {
    if (firstMesAutoSeedAttempted.current) {
      return;
    }
    if (initialMessages.length > 0) {
      return;
    }
    if (!initialAssistantCharacterId?.trim()) {
      return;
    }
    firstMesAutoSeedAttempted.current = true;
    void (async () => {
      const res = await fetch(`/api/threads/${sessionId}/seed-first-mes`, {
        method: "POST",
      });
      if (!res.ok) {
        return;
      }
      const data = (await res.json()) as {
        inserted?: boolean;
        message?: { role: string; content: string };
      };
      if (
        data.inserted &&
        data.message?.role === "assistant" &&
        data.message.content
      ) {
        setMessages([{ role: "assistant", content: data.message.content }]);
      }
    })();
  }, [sessionId, initialAssistantCharacterId, initialMessages.length]);

  useEffect(() => {
    async function loadWorlds() {
      const response = await fetch("/api/worlds?include_versions=1&limit=50");
      if (!response.ok) {
        setWorldLoadStatus("世界列表加载失败。");
        return;
      }
      const payload = (await response.json()) as { worlds: WorldWithVersions[] };
      setWorldsWithVersions(payload.worlds ?? []);
      setWorldLoadStatus(
        (payload.worlds?.length ?? 0) === 0
          ? "暂无世界，请先到「世界书」导入"
          : "选择要注入对话的世界版本"
      );
    }
    loadWorlds().catch(() => {
      setWorldLoadStatus("世界列表加载失败。");
    });
  }, [sessionId]);

  async function loadSessionEvents() {
    setEventsLoadStatus("加载事件…");
    const response = await fetch(`/api/threads/${sessionId}/events`);
    if (!response.ok) {
      setEventsLoadStatus("事件列表加载失败。");
      return;
    }
    const payload = (await response.json()) as { events?: SessionEventRow[] };
    setSessionEvents(payload.events ?? []);
    setEventsLoadStatus(`${(payload.events ?? []).length} 条记录`);
  }

  async function loadSessionState() {
    const response = await fetch(`/api/threads/${sessionId}`);
    if (!response.ok) return;
    const data = (await response.json()) as {
      thread?: { sessionState?: Record<string, unknown> };
    };
    if (data.thread?.sessionState) {
      setSessionState(data.thread.sessionState);
    }
  }

  useEffect(() => {
    void loadSessionEvents();
    void loadSessionState();
  }, [sessionId]);

  useEffect(() => {
    setSessionState(initialSessionState);
  }, [initialSessionState, sessionId]);

  useEffect(() => {
    if (!autoPilotEnabled) return;
    const timer = setInterval(() => {
      if (isStreaming) return;
      if (typeof document !== "undefined" && document.visibilityState !== "visible") {
        return;
      }
      if (input.trim().length > 0) return;
      const now = Date.now();
      if (now - autoPilotLastAtRef.current < autoPilotIntervalSec * 1000) {
        return;
      }
      autoPilotLastAtRef.current = now;
      setInput("/推进");
      setTimeout(() => {
        sendFormRef.current?.requestSubmit();
      }, 0);
    }, 1000);
    return () => clearInterval(timer);
  }, [autoPilotEnabled, autoPilotIntervalSec, isStreaming, input]);

  async function handleSend(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const text = input.trim();
    if (!text || isStreaming) return;
    const isAutoTurnCommand = text === "/推进" || text === "/next";
    autoPilotLastAtRef.current = Date.now();

    setIsStreaming(true);
    setStatus(isAutoTurnCommand ? "世界正在主动推进…" : "正在生成回复…");

    const assistantIndex = isAutoTurnCommand ? messages.length : messages.length + 1;
    setMessages((prev) =>
      isAutoTurnCommand
        ? [...prev, { role: "assistant", content: "" }]
        : [...prev, { role: "user", content: text }, { role: "assistant", content: "" }]
    );
    setInput("");

    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        isAutoTurnCommand
          ? { sessionId, mode: "auto", autoProfile: autoPilotProfile }
          : { sessionId, text }
      ),
    });

    if (!response.ok || !response.body) {
      let detail = `HTTP ${response.status}`;
      try {
        const errBody = (await response.json()) as { error?: string };
        if (errBody?.error) detail = errBody.error;
      } catch {
        /* ignore */
      }
      setStatus(detail);
      setMessages((prev) =>
        prev.map((message, index) =>
          index === assistantIndex
            ? {
                ...message,
                content:
                  message.content.trim().length > 0
                    ? message.content
                    : `[错误] ${detail}`,
              }
            : message
        )
      );
      setIsStreaming(false);
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = "";

    const pushDreTraceLine = (line: string) => {
      setMessages((prev) =>
        prev.map((message, index) => {
          if (index !== assistantIndex || message.role !== "assistant") {
            return message;
          }
          const next = [...(message.dreTrace ?? []), line];
          return { ...message, dreTrace: next };
        })
      );
    };

    const pushReactTraceEntry = (entry: ReactTraceEntry) => {
      setMessages((prev) =>
        prev.map((message, index) => {
          if (index !== assistantIndex || message.role !== "assistant") {
            return message;
          }
          const next = [...(message.reactTrace ?? []), entry];
          return { ...message, reactTrace: next };
        })
      );
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      pending += decoder.decode(value, { stream: true });
      const { events, rest } = parseSseBlocks(pending);
      pending = rest;

      for (const eventItem of events) {
        if (!eventItem.rawData) continue;
        const parsed = JSON.parse(eventItem.rawData) as {
          delta?: string;
        };

        if (eventItem.eventName === "turn_started") {
          try {
            const ts = JSON.parse(eventItem.rawData) as { turnNumber?: number };
            setStatus(
              typeof ts.turnNumber === "number"
                ? `第 ${ts.turnNumber} 回合开始`
                : "回合开始"
            );
          } catch {
            setStatus("回合开始");
          }
          continue;
        }

        if (eventItem.eventName === "state_patched") {
          try {
            const st = JSON.parse(eventItem.rawData) as {
              keys?: string[];
              state?: Record<string, unknown>;
            };
            if (st.state && typeof st.state === "object") {
              setSessionState(st.state);
            }
            setStatus(
              Array.isArray(st.keys) && st.keys.length > 0
                ? `状态已更新：${st.keys.join(", ")}`
                : "会话状态已更新"
            );
          } catch {
            setStatus("状态补丁事件已收到");
          }
          continue;
        }

        if (eventItem.eventName === "dre_intent") {
          try {
            const d = JSON.parse(eventItem.rawData) as {
              kind?: string;
              reason?: string;
              source?: string;
            };
            const label =
              d.kind === "action" ? "动作推演" : d.kind === "dialogue" ? "对话" : "未知";
            const src =
              d.source === "llm"
                ? "模型"
                : d.source === "hybrid"
                  ? "规则+模型"
                  : d.source === "rules"
                    ? "规则"
                    : "";
            setStatus(
              `DRE：${label}${src ? ` · ${src}` : ""}${d.reason ? `（${d.reason}）` : ""}`
            );
            pushDreTraceLine(
              `意图：${label}${src ? ` · ${src}` : ""}${d.reason ? ` · ${d.reason}` : ""}`
            );
          } catch {
            setStatus("DRE 意图事件");
          }
          continue;
        }

        if (eventItem.eventName === "dre_autopilot_plan") {
          try {
            const p = JSON.parse(eventItem.rawData) as {
              shouldAdvance?: boolean;
              reason?: string;
              npcNames?: string[];
              profile?: "conservative" | "standard" | "aggressive";
            };
            const npcText =
              Array.isArray(p.npcNames) && p.npcNames.length > 0
                ? ` · NPC：${p.npcNames.join("、")}`
                : "";
            const profileText =
              p.profile === "conservative"
                ? "保守"
                : p.profile === "aggressive"
                  ? "激进"
                  : "标准";
            setStatus(
              p.shouldAdvance
                ? `自动档（${profileText}）：导演判定推进${npcText}`
                : `自动档（${profileText}）：导演判定暂缓推进${npcText}`
            );
            pushDreTraceLine(
              `自动规划：${p.shouldAdvance ? "推进" : "暂缓"}${
                p.reason ? ` · ${p.reason}` : ""
              }${npcText} · 档位:${profileText}`
            );
          } catch {
            setStatus("自动档：导演已完成本拍规划");
          }
          continue;
        }

        if (eventItem.eventName === "dre_environment") {
          try {
            const env = JSON.parse(eventItem.rawData) as {
              event_summary?: string;
              risk_level?: string;
            };
            const s = env.event_summary ?? JSON.stringify(env).slice(0, 120);
            setStatus("DRE：环境判定完成");
            pushDreTraceLine(`环境：${s}`);
          } catch {
            setStatus("DRE 环境事件");
          }
          continue;
        }

        if (eventItem.eventName === "dre_a2a") {
          try {
            const a = JSON.parse(eventItem.rawData) as {
              summary?: string;
              npcLines?: Array<{ name?: string; intent?: string }>;
              roundsUsed?: number;
              beatId?: string;
              transcriptPreview?: string;
            };
            setStatus("DRE：NPC 协调完成，导演生成中…");
            const npcBit =
              Array.isArray(a.npcLines) && a.npcLines.length > 0
                ? a.npcLines
                    .map((x) => `${x.name ?? "?"}：${x.intent ?? ""}`)
                    .join(" · ")
                : "";
            const roundBit =
              typeof a.roundsUsed === "number" ? ` · ${a.roundsUsed} 轮总线` : "";
            pushDreTraceLine(
              `A2A${roundBit}：${a.summary ?? ""}${npcBit ? ` | ${npcBit}` : ""}`
            );
            if (a.transcriptPreview && a.transcriptPreview.trim().length > 0) {
              pushDreTraceLine(
                `总线摘录：${a.transcriptPreview.length > 600 ? `${a.transcriptPreview.slice(0, 600)}…` : a.transcriptPreview}`
              );
            }
          } catch {
            setStatus("DRE A2A 事件");
          }
          continue;
        }

        if (eventItem.eventName === "react_thought") {
          try {
            const r = JSON.parse(eventItem.rawData) as {
              toolName?: string;
              thought?: string | null;
              compliant?: boolean;
            };
            const thoughtText =
              r.thought === undefined || r.thought === null
                ? null
                : typeof r.thought === "string"
                  ? r.thought
                  : null;
            pushReactTraceEntry({
              kind: "thought",
              toolName: String(r.toolName ?? "?"),
              text: thoughtText,
              compliant: Boolean(r.compliant),
            });
            setStatus(
              r.compliant
                ? `ReAct：Thought → ${r.toolName ?? "?"}`
                : `ReAct：未检测到 Thought:（仍将调用 ${r.toolName ?? "?"}）`
            );
          } catch {
            setStatus("ReAct Thought 事件");
          }
          continue;
        }

        if (eventItem.eventName === "react_observation") {
          try {
            const r = JSON.parse(eventItem.rawData) as {
              toolName?: string;
              preview?: string;
              ok?: boolean;
              error?: string;
            };
            pushReactTraceEntry({
              kind: "observation",
              toolName: String(r.toolName ?? "?"),
              preview: String(r.preview ?? ""),
              ok: r.ok !== false,
              error: typeof r.error === "string" ? r.error : undefined,
            });
            setStatus(
              r.ok === false
                ? `ReAct：Observation 失败 · ${r.toolName ?? "?"}`
                : `ReAct：Observation · ${r.toolName ?? "?"}`
            );
          } catch {
            setStatus("ReAct Observation 事件");
          }
          continue;
        }

        if (eventItem.eventName === "dre_entities") {
          try {
            const e = JSON.parse(eventItem.rawData) as {
              method?: string;
              pickedNames?: string[];
              pickedIds?: string[];
            };
            const names = Array.isArray(e.pickedNames)
              ? e.pickedNames.join("、")
              : "";
            setStatus(
              `DRE 实体：${e.method === "llm" ? "模型" : "启发式"}选取 ${e.pickedNames?.length ?? 0} 个`
            );
            pushDreTraceLine(
              `实体锚点（${e.method ?? "?"}）：${names || (e.pickedIds ?? []).join(", ")}`
            );
          } catch {
            setStatus("DRE 实体事件");
          }
          continue;
        }

        if (eventItem.eventName === "layered_memory") {
          try {
            const lm = JSON.parse(eventItem.rawData) as {
              phase?: string;
              sharedGoalCount?: number;
              privateNpcBuckets?: number;
              insightsInserted?: number;
            };
            const ph = lm.phase === "supervisor" ? "监督者已更新" : "分层记忆已注入";
            setStatus(
              `${ph} · 共享目标 ${String(lm.sharedGoalCount ?? 0)} · 私域桶 ${String(lm.privateNpcBuckets ?? 0)}` +
                (typeof lm.insightsInserted === "number" && lm.insightsInserted > 0
                  ? ` · 新洞察 ${lm.insightsInserted}`
                  : "")
            );
          } catch {
            setStatus("分层记忆事件已收到");
          }
          continue;
        }

        if (eventItem.eventName === "mem0_context") {
          try {
            const m = JSON.parse(eventItem.rawData) as {
              hits?: number;
              memories?: string[];
            };
            const n = typeof m.hits === "number" ? m.hits : 0;
            setStatus(
              n > 0
                ? `Mem0：已注入 ${n} 条相关记忆`
                : "Mem0：检索完成"
            );
          } catch {
            setStatus("Mem0：上下文已更新");
          }
          continue;
        }

        if (eventItem.eventName === "dre_memory") {
          try {
            const m = JSON.parse(eventItem.rawData) as {
              addedFacts?: number;
              newConflicts?: number;
              totalEntries?: number;
              totalConflicts?: number;
            };
            setStatus(
              `DRE 记忆：+${m.addedFacts ?? 0} 条事实 · +${m.newConflicts ?? 0} 条冲突记录`
            );
            pushDreTraceLine(
              `记忆：新增事实 ${m.addedFacts ?? 0}，新冲突 ${m.newConflicts ?? 0}；累计 ${m.totalEntries ?? "?"} 条 / 冲突 ${m.totalConflicts ?? "?"} 条`
            );
          } catch {
            setStatus("DRE 记忆事件");
          }
          continue;
        }

        if (eventItem.eventName === "tool_called") {
          try {
            const raw = JSON.parse(eventItem.rawData) as Record<string, unknown>;
            if (raw.source === "agent" && typeof raw.toolName === "string") {
              const agentToolName = raw.toolName;
              const inputSummary = summarizeAgentToolInput(
                agentToolName,
                raw.input
              );
              setMessages((prev) =>
                prev.map((message, index) => {
                  if (index !== assistantIndex || message.role !== "assistant") {
                    return message;
                  }
                  const trace: AgentTraceEntry[] = [
                    ...(message.agentTrace ?? []),
                    {
                      kind: "call",
                      toolName: agentToolName,
                      toolCallId: String(raw.toolCallId ?? ""),
                      inputSummary,
                    },
                  ];
                  return { ...message, agentTrace: trace };
                })
              );
              setStatus(
                `Agent 调用「${agentToolName}」${inputSummary ? `：${inputSummary}` : ""}…`
              );
              continue;
            }

            const tool = raw as {
              tool?: string;
              input?: { expression?: string };
              output?: { total?: number; rolls?: number[] };
            };
            if (tool.tool === "dice_roller" && tool.output?.rolls) {
              setStatus(
                `掷骰 ${tool.input?.expression ?? "?"} → [${tool.output.rolls.join(", ")}] 合计 ${tool.output.total ?? "?"}`
              );
            } else {
              setStatus(`工具调用：${tool.tool ?? "unknown"}`);
            }
          } catch {
            setStatus("工具事件已收到");
          }
          continue;
        }

        if (eventItem.eventName === "agent_tool_finished") {
          try {
            const data = JSON.parse(eventItem.rawData) as {
              toolName?: string;
              toolCallId?: string;
              ok?: boolean;
              outputPreview?: string;
              error?: string;
              dice?: Record<string, unknown>;
            };
            const toolName = String(data.toolName ?? "?");
            const summary = formatAgentToolFinishedSummary({
              toolName,
              ok: Boolean(data.ok),
              dice: data.dice,
              outputPreview: data.outputPreview,
              error: data.error,
            });
            setMessages((prev) =>
              prev.map((message, index) => {
                if (index !== assistantIndex || message.role !== "assistant") {
                  return message;
                }
                const trace: AgentTraceEntry[] = [
                  ...(message.agentTrace ?? []),
                  {
                    kind: "done",
                    toolName,
                    toolCallId: String(data.toolCallId ?? ""),
                    ok: Boolean(data.ok),
                    summary,
                  },
                ];
                return { ...message, agentTrace: trace };
              })
            );
            setStatus(
              data.ok ? `「${toolName}」完成` : `「${toolName}」失败`
            );
          } catch {
            setStatus("Agent 工具结束事件已收到");
          }
          continue;
        }

        if (eventItem.eventName === "token") {
          const delta = parsed.delta ?? "";
          setMessages((prev) =>
            prev.map((message, index) =>
              index === assistantIndex
                ? { ...message, content: `${message.content}${delta}` }
                : message
            )
          );
          continue;
        }

        if (eventItem.eventName === "error") {
          let msg = "模型调用出错";
          try {
            const err = JSON.parse(eventItem.rawData) as { message?: string };
            if (err.message) msg = err.message;
          } catch {
            /* ignore */
          }
          setStatus(msg);
          setMessages((prev) =>
            prev.map((message, index) =>
              index === assistantIndex
                ? {
                    ...message,
                    content: message.content
                      ? `${message.content}\n\n[错误] ${msg}`
                      : `[错误] ${msg}`,
                  }
                : message
            )
          );
          continue;
        }

        if (eventItem.eventName === "turn_finished") {
          try {
            const d = JSON.parse(eventItem.rawData) as {
              displayMessage?: string;
              speakerLabel?: string | null;
            };
            setMessages((prev) => {
              const target = prev[assistantIndex];
              if (!target || target.role !== "assistant") {
                return prev;
              }
              const nextContent =
                typeof d.displayMessage === "string"
                  ? d.displayMessage
                  : target.content;
              let nextSpeaker: string | undefined;
              if ("speakerLabel" in d) {
                if (typeof d.speakerLabel === "string" && d.speakerLabel.trim()) {
                  nextSpeaker = d.speakerLabel.trim();
                } else {
                  nextSpeaker = undefined;
                }
              } else {
                nextSpeaker = target.speakerLabel;
              }
              const normalized: Message = {
                ...target,
                content: nextContent,
                speakerLabel: nextSpeaker,
              };
              const expanded = expandAssistantSceneToGroupMessages(normalized);
              return [
                ...prev.slice(0, assistantIndex),
                ...expanded,
                ...prev.slice(assistantIndex + 1),
              ];
            });
          } catch {
            /* 保持流式累积正文 */
          }
          setStatus("本回合结束");
        }
      }
    }

    setIsStreaming(false);
    void loadSessionEvents();
    void loadSessionState();
  }

  async function handleModelChange(nextValue: string) {
    setSelectedModel(nextValue);
    const [provider, modelId] = nextValue.split("::");
    if (!provider || !modelId) return;

    setModelStatus("保存中…");
    const response = await fetch(`/api/threads/${sessionId}/model`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider, modelId }),
    });

    if (!response.ok) {
      setModelStatus("保存模型失败。");
      return;
    }
    setModelStatus("已保存为本会话模型");
  }

  async function handleWorldVersionChange(nextVersionId: string) {
    setBoundWorldVersionId(nextVersionId);
    setWorldBindStatus("保存中…");
    const response = await fetch(`/api/threads/${sessionId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        worldVersionId: nextVersionId.length > 0 ? nextVersionId : null,
      }),
    });
    if (!response.ok) {
      let detail = "绑定失败";
      try {
        const j = (await response.json()) as { error?: string };
        if (j.error) detail = j.error;
      } catch {
        /* ignore */
      }
      setWorldBindStatus(detail);
      return;
    }
    setWorldBindStatus(
      nextVersionId
        ? "已绑定：后续发言将携带该版本设定"
        : "已解除世界绑定"
    );
  }

  async function handlePersonaChange(nextPersonaId: string) {
    const prev = selectedPersonaId;
    setSelectedPersonaId(nextPersonaId);
    setRpBindStatus("保存人格…");
    const response = await fetch(`/api/threads/${sessionId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        personaId: nextPersonaId.length > 0 ? nextPersonaId : null,
      }),
    });
    if (!response.ok) {
      setSelectedPersonaId(prev);
      let detail = "保存失败";
      try {
        const j = (await response.json()) as { error?: string };
        if (j.error) detail = j.error;
      } catch {
        /* ignore */
      }
      setRpBindStatus(detail);
      return;
    }
    setRpBindStatus("人格已保存");
  }

  async function handleCharacterChange(nextCharacterId: string) {
    const prev = selectedCharacterId;
    setSelectedCharacterId(nextCharacterId);
    setRpBindStatus("保存角色…");
    const response = await fetch(`/api/threads/${sessionId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        activeCharacterBoundEntityId:
          nextCharacterId.length > 0 ? nextCharacterId : null,
      }),
    });
    if (!response.ok) {
      setSelectedCharacterId(prev);
      let detail = "保存失败";
      try {
        const j = (await response.json()) as { error?: string };
        if (j.error) detail = j.error;
      } catch {
        /* ignore */
      }
      setRpBindStatus(detail);
      return;
    }
    setRpBindStatus("角色已保存");
  }

  async function handleAssistantCharacterChange(nextId: string) {
    const prev = selectedAssistantCharacterId;
    setSelectedAssistantCharacterId(nextId);
    setRpBindStatus("保存 AI 角色…");
    const response = await fetch(`/api/threads/${sessionId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        assistantCharacterId: nextId.length > 0 ? nextId : null,
      }),
    });
    if (!response.ok) {
      setSelectedAssistantCharacterId(prev);
      let detail = "保存失败";
      try {
        const j = (await response.json()) as { error?: string };
        if (j.error) detail = j.error;
      } catch {
        /* ignore */
      }
      setRpBindStatus(detail);
      return;
    }
    setRpBindStatus("AI 角色已保存");
    const seedRes = await fetch(`/api/threads/${sessionId}/seed-first-mes`, {
      method: "POST",
    });
    if (seedRes.ok) {
      const seedData = (await seedRes.json()) as {
        inserted?: boolean;
        message?: { role: string; content: string };
      };
      const opening = seedData.message?.content;
      if (
        seedData.inserted &&
        seedData.message?.role === "assistant" &&
        opening
      ) {
        setMessages((prev) =>
          prev.length === 0 ? [{ role: "assistant", content: opening }] : prev
        );
        setRpBindStatus("AI 角色已保存 · 已插入开场 first_mes");
      }
    }
  }

  async function handleInsertFirstMesFromAssistant() {
    const id = selectedAssistantCharacterId.trim();
    if (!id) {
      setRpBindStatus("请先选择 AI 角色（角色库）");
      return;
    }
    setRpBindStatus("读取首条消息…");
    const res = await fetch(`/api/characters/${id}`);
    if (!res.ok) {
      setRpBindStatus("读取角色失败");
      return;
    }
    const payload = (await res.json()) as {
      character?: { character_card_json?: string };
    };
    const raw = payload.character?.character_card_json;
    let firstMes = "";
    try {
      const o = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      if (typeof o.first_mes === "string" && o.first_mes.trim()) {
        firstMes = o.first_mes.trim();
      }
    } catch {
      setRpBindStatus("角色卡 JSON 无效");
      return;
    }
    if (!firstMes) {
      setRpBindStatus("该角色未填写 first_mes（第一条消息）");
      return;
    }
    setInput(firstMes);
    setRpBindStatus("已填入首条消息，可编辑后发送");
  }

  async function handleQuickCreatePersona() {
    const name = newPersonaName.trim();
    if (!name) return;
    setRpBindStatus("创建人格…");
    const response = await fetch("/api/personas", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    if (!response.ok) {
      let detail = "创建失败";
      try {
        const j = (await response.json()) as { error?: string };
        if (j.error) detail = j.error;
      } catch {
        /* ignore */
      }
      setRpBindStatus(detail);
      return;
    }
    const payload = (await response.json()) as { persona?: PersonaRow };
    const created = payload.persona;
    if (!created) {
      setRpBindStatus("响应异常");
      return;
    }
    setPersonas((prev) => {
      const rest = prev.filter((p) => p.id !== created.id);
      return [created, ...rest];
    });
    setNewPersonaName("");
    await handlePersonaChange(created.id);
  }

  return (
    <div className="panel" style={{ marginTop: "1rem" }}>
      <h2 style={{ marginTop: 0 }}>与 {assistantDisplayLabel} 对话</h2>
      <div className="row" style={{ marginBottom: "0.5rem", gap: "0.6rem" }}>
        <label
          className="muted"
          style={{ display: "inline-flex", alignItems: "center", gap: "0.4rem" }}
        >
          <input
            type="checkbox"
            checked={simpleUiMode}
            onChange={(e) => setSimpleUiMode(e.target.checked)}
          />
          简洁模式（推荐）
        </label>
      </div>
      {!simpleUiMode ? (
        <p className="muted" style={{ fontSize: "0.82rem", marginTop: "-0.35rem" }}>
          多人剧情时，模型可在回复<strong>最前</strong>单独一行写{" "}
          <code className="code-inline">[CW_SPEAKER:名字]</code> 或{" "}
          <code className="code-inline">【说话者：名字】</code>
          ，气泡旁会按回合切换显示名（该行不会留在正文里）。
        </p>
      ) : null}
      {!simpleUiMode && agentMcpConfigured && !chatMockConfigured ? (
        <p className="agent-mcp-hint muted">
          本环境已开启 <span className="code-inline">CW_AGENT_MCP</span>
          ：助手气泡内会显示<strong> 调用 / 结果 </strong>
          轨迹；详细审计仍在下方「会话事件流」。
        </p>
      ) : null}
      {!simpleUiMode && reactFrameworkConfigured && agentMcpConfigured && !chatMockConfigured ? (
        <p className="muted" style={{ marginTop: 0 }}>
          已开启 <span className="code-inline">CW_REACT_FRAMEWORK</span>
          ：每次工具调用前应在可见文本中带 <strong>Thought:</strong>；服务端将工具返回记为{" "}
          <strong>Observation</strong>，并在气泡下展示「ReAct 轨迹」；事件流中对应{" "}
          <span className="code-inline">react_thought</span> /{" "}
          <span className="code-inline">react_observation</span>。
        </p>
      ) : null}
      {!simpleUiMode && agentMcpConfigured && chatMockConfigured ? (
        <p className="muted" style={{ marginTop: 0 }}>
          已配置 Agent 环境变量，但 Mock 模式下不会执行真实工具链。
        </p>
      ) : null}
      {!simpleUiMode && dynamicRpConfigured && !chatMockConfigured ? (
        <p className="muted" style={{ marginTop: 0 }}>
          已开启 <span className="code-inline">CW_DYNAMIC_RP_ENGINE</span>
          ：本会话将按意图分流；<strong>动作线</strong>会跑环境 + 多 NPC + 导演（动作回合暂不挂载
          Agent 工具）；环境推演会读取会话中的{" "}
          <span className="code-inline">lastDice</span>（若本回合前掷过骰）。详见{" "}
          <span className="code-inline">docs/dynamic-rp-engine.md</span>。
          {dreIntentLlmMode !== "off" ? (
            <>
              {" "}
              意图分类：<span className="code-inline">CW_DRE_INTENT_LLM</span>=
              <strong>{dreIntentLlmMode === "full" ? "full" : "hybrid"}</strong>
              {dreIntentLlmMode === "hybrid"
                ? "（规则未命中时再问模型）"
                : "（每轮模型分类）"}
              。
            </>
          ) : null}
          {dreA2aInteractionRounds > 1 ? (
            <>
              {" "}
              A2A 广播轮数：<span className="code-inline">CW_DRE_A2A_ROUNDS</span>=
              <strong>{dreA2aInteractionRounds}</strong>。
            </>
          ) : null}
          {dreA2aRedisConfigured ? (
            <>
              {" "}
              已配置 <span className="code-inline">CW_DRE_A2A_REDIS_URL</span>
              ：总线镜像 + 跨拍上下文。
            </>
          ) : null}
          {dreMemoryConfigured ? (
            <>
              {" "}
              <span className="code-inline">CW_DRE_MEMORY</span>：动作线会抽取工作记忆并检测事实冲突；对话线只读记忆摘要。
            </>
          ) : null}
          {dreWorldEntitiesConfigured ? (
            <>
              {" "}
              <span className="code-inline">CW_DRE_WORLD_ENTITIES</span>
              ：绑定世界后按本回合文本选取实体锚点（可选{" "}
              <span className="code-inline">CW_DRE_ENTITY_LLM</span> 精排）。
            </>
          ) : null}
        </p>
      ) : null}
      <p className="muted">状态：{status}</p>
      {simpleUiMode ? (
        <details
          className="panel"
          style={{ marginBottom: "0.9rem", padding: "0.65rem 0.9rem" }}
        >
          <summary style={{ cursor: "pointer", fontWeight: 600 }}>高级设置（模型/角色/世界/调试）</summary>
          <div style={{ marginTop: "0.6rem" }}>
            <div style={{ marginBottom: "0.8rem" }}>
              <label htmlFor="world-version-select">绑定世界版本（注入设定上下文）</label>
              <select
                id="world-version-select"
                className="input"
                value={boundWorldVersionId}
                onChange={(event) => {
                  void handleWorldVersionChange(event.target.value);
                }}
                style={{ marginTop: "0.35rem" }}
              >
                <option value="">不绑定</option>
                {worldsWithVersions.flatMap((world) =>
                  world.versions.map((v) => (
                    <option key={v.id} value={v.id}>
                      {world.name} · v{v.version}
                    </option>
                  ))
                )}
              </select>
              <p className="muted" style={{ marginBottom: 0 }}>
                {worldLoadStatus}
                {worldBindStatus ? ` · ${worldBindStatus}` : ""}
              </p>
            </div>
            <div style={{ marginBottom: "0.8rem" }}>
              <label htmlFor="assistant-character-select">
                AI 扮演角色（角色库）
              </label>
              <select
                id="assistant-character-select"
                className="input"
                value={selectedAssistantCharacterId}
                onChange={(event) => {
                  void handleAssistantCharacterChange(event.target.value);
                }}
                style={{ marginTop: "0.35rem" }}
              >
                <option value="">不指定（场景模式，无具体角色卡）</option>
                {tavernCharacters.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                    {c.tags?.trim() ? ` · ${c.tags}` : ""}
                  </option>
                ))}
              </select>
            </div>
            <div style={{ marginBottom: "0.8rem" }}>
              <label htmlFor="model-select">本会话模型</label>
              <select
                id="model-select"
                className="input"
                value={selectedModel}
                onChange={(event) => {
                  void handleModelChange(event.target.value);
                }}
                style={{ marginTop: "0.35rem" }}
              >
                {modelOptions.map((option) => {
                  const value = `${option.provider}::${option.modelId}`;
                  return (
                    <option key={value} value={value}>
                      {option.label}
                    </option>
                  );
                })}
              </select>
              <p className="muted" style={{ marginBottom: 0 }}>
                {modelStatus}
              </p>
            </div>
          </div>
        </details>
      ) : (
      <>
      <div style={{ marginBottom: "0.8rem" }}>
        <label htmlFor="world-version-select">绑定世界版本（注入设定上下文）</label>
        <select
          id="world-version-select"
          className="input"
          value={boundWorldVersionId}
          onChange={(event) => {
            void handleWorldVersionChange(event.target.value);
          }}
          style={{ marginTop: "0.35rem" }}
        >
          <option value="">不绑定</option>
          {worldsWithVersions.flatMap((world) =>
            world.versions.map((v) => (
              <option key={v.id} value={v.id}>
                {world.name} · v{v.version}
              </option>
            ))
          )}
        </select>
        <p className="muted" style={{ marginBottom: 0 }}>
          {worldLoadStatus}
          {worldBindStatus ? ` · ${worldBindStatus}` : ""}
        </p>
      </div>
      <div style={{ marginBottom: "0.8rem" }}>
        <label htmlFor="assistant-character-select">
          AI 扮演角色（角色库，对齐 SillyTavern「角色」）
        </label>
        <select
          id="assistant-character-select"
          className="input"
          value={selectedAssistantCharacterId}
          onChange={(event) => {
            void handleAssistantCharacterChange(event.target.value);
          }}
          style={{ marginTop: "0.35rem" }}
        >
          <option value="">不指定（场景模式，无具体角色卡）</option>
          {tavernCharacters.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
              {c.tags?.trim() ? ` · ${c.tags}` : ""}
            </option>
          ))}
        </select>
        <div
          className="row"
          style={{
            marginTop: "0.5rem",
            flexWrap: "wrap",
            gap: "0.5rem",
            alignItems: "center",
          }}
        >
          <Link className="button" href="/tavern/characters">
            管理角色库
          </Link>
          <button
            type="button"
            className="button"
            disabled={!selectedAssistantCharacterId.trim() || isStreaming}
            onClick={() => void handleInsertFirstMesFromAssistant()}
          >
            将 first_mes 填入输入框
          </button>
        </div>
        <p className="muted" style={{ marginBottom: 0 }}>
          定义模型扮演的 AI 身份；与下方「人格」（玩家）及世界书中扮演条目不同。若本会话尚无消息且角色填写了
          first_mes，打开页面或在此选择角色后会<strong>自动插入一条助手开场消息</strong>（对齐
          SillyTavern）。也可用上方按钮把 first_mes 填进输入框自行改写。
        </p>
      </div>
      <div style={{ marginBottom: "0.8rem" }}>
        <label htmlFor="persona-select">玩家人格（Persona）</label>
        <select
          id="persona-select"
          className="input"
          value={selectedPersonaId}
          onChange={(event) => {
            void handlePersonaChange(event.target.value);
          }}
          style={{ marginTop: "0.35rem" }}
        >
          <option value="">不启用</option>
          {personas.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <div
          style={{
            marginTop: "0.5rem",
            display: "flex",
            gap: "0.5rem",
            flexWrap: "wrap",
            alignItems: "center",
          }}
        >
          <input
            type="text"
            className="input"
            placeholder="新建人格名称"
            value={newPersonaName}
            onChange={(event) => setNewPersonaName(event.target.value)}
            style={{ flex: "1 1 12rem", minWidth: "10rem" }}
          />
          <button
            type="button"
            className="button"
            disabled={!newPersonaName.trim()}
            onClick={() => {
              void handleQuickCreatePersona();
            }}
          >
            快速新建
          </button>
        </div>
        <p className="muted" style={{ marginBottom: 0 }}>
          系统提示注入顺序：世界 → AI 角色 → 世界书中扮演 → 人格（见{" "}
          <a
            href="https://sillytavern.wiki/usage/characters/"
            target="_blank"
            rel="noreferrer"
          >
            ST 文档
          </a>
          ）。
          {rpBindStatus ? ` · ${rpBindStatus}` : ""}
        </p>
      </div>
      <div style={{ marginBottom: "0.8rem" }}>
        <label htmlFor="character-select">世界书中扮演角色（character_books）</label>
        <select
          id="character-select"
          className="input"
          value={selectedCharacterId}
          onChange={(event) => {
            void handleCharacterChange(event.target.value);
          }}
          disabled={!boundWorldVersionId}
          style={{ marginTop: "0.35rem" }}
        >
          <option value="">不指定</option>
          {characterOptions.map((c) => (
            <option key={c.bound_entity_id} value={c.bound_entity_id}>
              {c.label}
            </option>
          ))}
        </select>
        {!boundWorldVersionId ? (
          <p className="muted" style={{ marginBottom: 0 }}>
            请先绑定世界版本以加载可选角色。
          </p>
        ) : characterOptions.length === 0 ? (
          <p className="muted" style={{ marginBottom: 0 }}>
            当前 Canonical 中暂无 character_books 条目。
          </p>
        ) : null}
      </div>
      <div style={{ marginBottom: "0.8rem" }}>
        <label htmlFor="model-select">本会话模型</label>
        <select
          id="model-select"
          className="input"
          value={selectedModel}
          onChange={(event) => {
            void handleModelChange(event.target.value);
          }}
          style={{ marginTop: "0.35rem" }}
        >
          {modelOptions.map((option) => {
            const value = `${option.provider}::${option.modelId}`;
            return (
              <option key={value} value={value}>
                {option.label}
              </option>
            );
          })}
        </select>
        <p className="muted" style={{ marginBottom: 0 }}>
          {modelStatus}
        </p>
      </div>

      <details
        className="panel"
        style={{ marginBottom: "0.9rem", padding: "0.65rem 0.9rem" }}
      >
        <summary style={{ cursor: "pointer", fontWeight: 600 }}>
          会话状态（state_patched）
        </summary>
        <p className="muted" style={{ marginTop: "0.5rem", marginBottom: "0.5rem" }}>
          掷骰或{" "}
          <code className="code-inline">PATCH /api/threads/&#123;id&#125;</code>{" "}
          传入 <code className="code-inline">sessionStatePatch</code>{" "}
          可浅合并顶层字段；已注入系统提示供模型参考。
        </p>
        <pre
          className="session-state-pre"
          style={{
            margin: 0,
            maxHeight: "8rem",
            overflow: "auto",
            fontSize: "0.78rem",
            padding: "0.5rem",
            borderRadius: "8px",
            background: "rgba(0,0,0,0.25)",
          }}
        >
          {Object.keys(sessionState).length === 0
            ? "{ }"
            : JSON.stringify(sessionState, null, 2)}
        </pre>
      </details>
      </>
      )}

      {!simpleUiMode ? (
      <details
        className="panel"
        style={{ marginBottom: "0.9rem", padding: "0.65rem 0.9rem" }}
      >
        <summary style={{ cursor: "pointer", fontWeight: 600 }}>
          会话事件流（回放 / 审计）· {sessionEvents.length} 条
        </summary>
        <p className="muted" style={{ marginTop: "0.5rem", marginBottom: "0.5rem" }}>
          {eventsLoadStatus} · 首行发 <code className="code-inline">/roll 2d6</code>{" "}
          可触发确定性掷骰（结果写入事件与模型上下文）。
          {agentMcpConfigured && !chatMockConfigured
            ? " · 模型侧工具会记录为 agent_tool_call / agent_tool_finished。"
            : ""}
        </p>
        <button
          type="button"
          className="button"
          style={{ marginBottom: "0.6rem" }}
          onClick={() => {
            void loadSessionEvents();
            void loadSessionState();
          }}
        >
          刷新事件与状态
        </button>
        {sessionEvents.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>
            暂无事件；发送一条消息后会记录回合边界与工具调用。
          </p>
        ) : (
          <ul
            className="session-event-list"
            style={{
              margin: 0,
              paddingLeft: "1.1rem",
              fontSize: "0.9rem",
              maxHeight: "11rem",
              overflowY: "auto",
            }}
          >
            {sessionEvents.map((ev) => (
              <li key={ev.id} style={{ marginBottom: "0.35rem" }}>
                <span className="muted">{ev.createdAt}</span> ·{" "}
                <strong>{ev.eventType}</strong>
                {ev.eventType === "turn_started" &&
                typeof ev.payload.turnNumber === "number" ? (
                  <>
                    {" "}
                    — 第 {String(ev.payload.turnNumber)} 轮{" "}
                    <button
                      type="button"
                      className="link-button"
                      onClick={() =>
                        document
                          .getElementById(`chat-turn-${String(ev.payload.turnNumber)}`)
                          ?.scrollIntoView({ behavior: "smooth", block: "center" })
                      }
                    >
                      跳转该轮
                    </button>
                  </>
                ) : null}
                {ev.eventType === "tool_called" &&
                ev.payload.tool === "dice_roller" ? (
                  <>
                    {" "}
                    —{" "}
                    {ev.payload.transport === "mcp_stdio" ? "（MCP） " : ""}
                    {String((ev.payload.input as { expression?: string })?.expression ?? "")}{" "}
                    → 合计{" "}
                    {String((ev.payload.output as { total?: number })?.total ?? "?")}
                  </>
                ) : ev.eventType === "state_patched" ? (
                  <>
                    {" "}
                    — keys:{" "}
                    {Array.isArray(ev.payload.keys)
                      ? (ev.payload.keys as string[]).join(", ")
                      : "?"}
                  </>
                ) : ev.eventType === "agent_tool_call" ? (
                  <>
                    {" "}
                    — {String(ev.payload.toolName ?? "?")}
                    {typeof ev.payload.input === "object" &&
                    ev.payload.input !== null
                      ? ` · ${summarizeAgentToolInput(
                          String(ev.payload.toolName ?? ""),
                          ev.payload.input
                        )}`
                      : ""}
                  </>
                ) : ev.eventType === "agent_tool_finished" ? (
                  <>
                    {" "}
                    — {String(ev.payload.toolName ?? "?")}{" "}
                    {ev.payload.ok === false ? "失败" : "成功"}
                    {typeof ev.payload.error === "string"
                      ? `：${ev.payload.error}`
                      : ""}
                  </>
                ) : ev.eventType === "error" ? (
                  <> — {String(ev.payload.message ?? "")}</>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </details>
      ) : null}

      <div className="chat-log">
        {messages.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>
            发送第一条消息，体验流式回复。
          </p>
        ) : (
          messages.map((message, index) => {
            const isCurrentAssistantStream =
              isStreaming &&
              message.role === "assistant" &&
              index === messages.length - 1;
            const bodyText =
              message.content.trim().length > 0
                ? message.content
                : message.role === "assistant"
                  ? isCurrentAssistantStream
                    ? "（叙事生成中…）"
                    : "…"
                  : "";
            const parsedScene =
              message.role === "assistant" ? parseScenePackage(bodyText) : null;

            return (
              <div
                key={`${message.role}-${index}`}
                id={
                  message.role === "user"
                    ? `chat-turn-${Math.floor(index / 2) + 1}`
                    : undefined
                }
                className={`chat-msg ${
                  message.role === "user" ? "chat-msg--user" : "chat-msg--assistant"
                }${message.role === "user" ? " chat-turn-anchor" : ""}`}
              >
                {(() => {
                  const displayName =
                    message.role === "user"
                      ? "你"
                      : message.speakerLabel?.trim() ||
                        (parsedScene ? "群像" : assistantDisplayLabel);
                  const visual =
                    message.role === "assistant"
                      ? getSpeakerVisual(displayName)
                      : {};
                  return (
                    <>
                      <div className="chat-msg-role" style={visual.roleStyle}>
                        {displayName}
                      </div>
                      <div className="chat-msg-body" style={visual.bodyStyle}>
                        {message.role === "assistant" &&
                        message.agentTrace &&
                        message.agentTrace.length > 0 ? (
                          <div className="agent-trace" aria-label="Agent 工具轨迹">
                            {message.agentTrace.map((entry, ti) => (
                              <div
                                key={`${entry.toolCallId}-${entry.kind}-${ti}`}
                                className={`agent-trace-row agent-trace-row--${entry.kind}`}
                              >
                                <span className="agent-trace-label">
                                  {entry.kind === "call" ? "调用" : "结果"}
                                </span>
                                <span className="agent-trace-tool">{entry.toolName}</span>
                                <span
                                  className="agent-trace-detail"
                                  style={
                                    entry.kind === "done" && !entry.ok
                                      ? { color: "var(--danger)" }
                                      : undefined
                                  }
                                >
                                  {entry.kind === "call"
                                    ? entry.inputSummary || "—"
                                    : entry.summary}
                                </span>
                              </div>
                            ))}
                          </div>
                        ) : null}
                        {message.role === "assistant" &&
                        message.reactTrace &&
                        message.reactTrace.length > 0 ? (
                          <details
                            className="react-trace"
                            style={{ marginBottom: "0.5rem", fontSize: "0.78rem" }}
                          >
                            <summary className="muted">ReAct 轨迹（Thought → Action → Observation）</summary>
                            <ul
                              style={{
                                margin: "0.35rem 0 0",
                                paddingLeft: "1.1rem",
                                listStyle: "none",
                              }}
                            >
                              {message.reactTrace.map((re, ri) => (
                                <li
                                  key={`react-${ri}-${re.kind}`}
                                  style={{
                                    marginBottom: "0.4rem",
                                    wordBreak: "break-word",
                                    borderLeft: "2px solid var(--border, #444)",
                                    paddingLeft: "0.5rem",
                                  }}
                                >
                                  {re.kind === "thought" ? (
                                    <>
                                      <strong className="muted">Thought</strong>
                                      <span className="muted"> · {re.toolName}</span>
                                      {!re.compliant ? (
                                        <span style={{ color: "var(--danger, #c44)" }}>
                                          {" "}
                                          （未检测到规范 Thought: 前缀）
                                        </span>
                                      ) : null}
                                      <div className="muted" style={{ marginTop: "0.2rem" }}>
                                        {re.text ?? "—"}
                                      </div>
                                    </>
                                  ) : (
                                    <>
                                      <strong className="muted">Observation</strong>
                                      <span className="muted"> · {re.toolName}</span>
                                      {!re.ok ? (
                                        <span style={{ color: "var(--danger, #c44)" }}>
                                          {" "}
                                          失败：{re.error ?? "?"}
                                        </span>
                                      ) : (
                                        <div className="muted" style={{ marginTop: "0.2rem" }}>
                                          {re.preview.length > 500
                                            ? `${re.preview.slice(0, 500)}…`
                                            : re.preview || "（空）"}
                                        </div>
                                      )}
                                    </>
                                  )}
                                </li>
                              ))}
                            </ul>
                          </details>
                        ) : null}
                        {message.role === "assistant" &&
                        message.dreTrace &&
                        message.dreTrace.length > 0 ? (
                          <details
                            className="dre-trace"
                            style={{ marginBottom: "0.5rem", fontSize: "0.78rem" }}
                          >
                            <summary className="muted">动态扮演引擎（本回合）</summary>
                            <ul style={{ margin: "0.35rem 0 0", paddingLeft: "1.1rem" }}>
                              {message.dreTrace.map((line, di) => (
                                <li key={`dre-${di}`} className="muted" style={{ wordBreak: "break-word" }}>
                                  {line}
                                </li>
                              ))}
                            </ul>
                          </details>
                        ) : null}
                        {parsedScene ? (
                          <div className="chat-msg-text" style={{ display: "grid", gap: "0.6rem" }}>
                            <div
                              style={{
                                borderLeft: "3px solid rgba(234,179,8,0.6)",
                                paddingLeft: "0.6rem",
                                whiteSpace: "pre-wrap",
                              }}
                            >
                              {parsedScene.scene}
                            </div>
                            <div style={{ display: "grid", gap: "0.45rem" }}>
                              {parsedScene.voices.map((v, vi) => (
                                <div
                                  key={`${v.speaker}-${vi}`}
                                  style={{
                                    border: "1px solid rgba(255,255,255,0.08)",
                                    borderRadius: "8px",
                                    padding: "0.45rem 0.6rem",
                                    background: "rgba(255,255,255,0.02)",
                                  }}
                                >
                                  <div
                                    style={{
                                      fontSize: "0.82rem",
                                      color: "var(--primary, #eab308)",
                                      marginBottom: "0.2rem",
                                    }}
                                  >
                                    {v.speaker}
                                  </div>
                                  <div style={{ whiteSpace: "pre-wrap" }}>{v.line}</div>
                                </div>
                              ))}
                            </div>
                            <div className="muted" style={{ whiteSpace: "pre-wrap" }}>
                              {parsedScene.wrap}
                            </div>
                          </div>
                        ) : (
                          <div className="chat-msg-text">{bodyText}</div>
                        )}
                      </div>
                    </>
                  );
                })()}
              </div>
            );
          })
        )}
      </div>

      <form ref={sendFormRef} onSubmit={handleSend}>
        <label htmlFor="chat-input">消息</label>
        <input
          id="chat-input"
          className="input"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder={`对 ${assistantDisplayLabel} 说点什么…`}
        />
        <div
          className="row"
          style={{ marginTop: "0.5rem", gap: "0.6rem", alignItems: "center", flexWrap: "wrap" }}
        >
          <label
            className="muted"
            style={{ display: "inline-flex", alignItems: "center", gap: "0.4rem" }}
          >
            <input
              type="checkbox"
              checked={autoPilotEnabled}
              disabled={isStreaming}
              onChange={(e) => {
                const next = e.target.checked;
                setAutoPilotEnabled(next);
                autoPilotLastAtRef.current = Date.now();
              }}
            />
            真自动档（静默时自动推进）
          </label>
          <label className="muted" style={{ display: "inline-flex", alignItems: "center", gap: "0.4rem" }}>
            间隔
            <select
              className="input"
              value={String(autoPilotIntervalSec)}
              disabled={!autoPilotEnabled || isStreaming}
              onChange={(e) => {
                const v = Number(e.target.value);
                setAutoPilotIntervalSec(Number.isFinite(v) ? v : 18);
                autoPilotLastAtRef.current = Date.now();
              }}
              style={{ width: "auto", minWidth: "5.2rem", padding: "0.3rem 0.45rem" }}
            >
              <option value="8">8 秒</option>
              <option value="12">12 秒</option>
              <option value="18">18 秒</option>
              <option value="25">25 秒</option>
              <option value="35">35 秒</option>
            </select>
          </label>
          <label className="muted" style={{ display: "inline-flex", alignItems: "center", gap: "0.4rem" }}>
            节奏
            <select
              className="input"
              value={autoPilotProfile}
              disabled={!autoPilotEnabled || isStreaming}
              onChange={(e) => {
                const v = e.target.value as "conservative" | "standard" | "aggressive";
                setAutoPilotProfile(v);
                autoPilotLastAtRef.current = Date.now();
              }}
              style={{ width: "auto", minWidth: "5.4rem", padding: "0.3rem 0.45rem" }}
            >
              <option value="conservative">保守</option>
              <option value="standard">标准</option>
              <option value="aggressive">激进</option>
            </select>
          </label>
        </div>
        <p className="muted" style={{ fontSize: "0.8rem", marginTop: "0.45rem" }}>
          输入 <code className="code-inline">/推进</code>（或 <code className="code-inline">/next</code>）可触发
          一次「世界主动推进」：不写入你的发言，改由 NPC/环境自行演化一拍。
        </p>
        <div className="row" style={{ marginTop: "0.5rem", gap: "0.5rem", flexWrap: "wrap" }}>
          <button
            type="submit"
            className="button primary"
            disabled={!canSend}
          >
            {isStreaming ? "生成中…" : "发送"}
          </button>
          <button
            type="button"
            className="button secondary"
            disabled={isStreaming}
            onClick={() => {
              if (isStreaming) return;
              setInput("/推进");
            }}
          >
            填入 /推进
          </button>
        </div>
      </form>
    </div>
  );
}
