"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

type Msg = { role: "user" | "assistant"; content: string };

type SseEvent = { eventName: string; rawData: string };

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

export default function ScreenwriterPanel({
  worldId,
  worldName,
  creationFlow = false,
  initialHasSavedVersion = false,
}: {
  worldId: string;
  worldName: string;
  /** URL ?new=1：从零共创流程 */
  creationFlow?: boolean;
  /** 进入页面时是否已有 world_versions（服务端） */
  initialHasSavedVersion?: boolean;
}) {
  const router = useRouter();
  const [useScratchCreation, setUseScratchCreation] = useState(
    () => creationFlow && !initialHasSavedVersion
  );
  const [messages, setMessages] = useState<Msg[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [loadStatus, setLoadStatus] = useState("加载对话…");
  const [status, setStatus] = useState("");
  const [isApplying, setIsApplying] = useState(false);
  const [applyHint, setApplyHint] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);

  const loadSession = useCallback(async () => {
    setLoadStatus("加载对话…");
    const res = await fetch(`/api/worlds/${worldId}/screenwriter`);
    if (!res.ok) {
      setLoadStatus("加载失败");
      return;
    }
    const data = (await res.json()) as {
      sessionId?: string;
      messages?: Msg[];
    };
    setSessionId(data.sessionId ?? null);
    setMessages(Array.isArray(data.messages) ? data.messages : []);
    setLoadStatus(
      (data.messages?.length ?? 0) === 0 ? "新会话，向编剧提问吧" : "已恢复历史对话"
    );
  }, [worldId]);

  useEffect(() => {
    void loadSession();
  }, [loadSession]);

  const canSend = useMemo(
    () => input.trim().length > 0 && !isStreaming,
    [input, isStreaming]
  );

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const text = input.trim();
    if (!text || isStreaming) return;

    setIsStreaming(true);
    setStatus("编剧思考中…");
    setInput("");

    const userMsg: Msg = { role: "user", content: text };
    setMessages((prev) => [...prev, userMsg, { role: "assistant", content: "" }]);
    const assistantIndex = messages.length + 1;

    const res = await fetch(`/api/worlds/${worldId}/screenwriter/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, scratchCreation: useScratchCreation }),
    });

    if (!res.ok || !res.body) {
      let detail = `HTTP ${res.status}`;
      try {
        const t = await res.text();
        if (t) detail = t.slice(0, 200);
      } catch {
        /* ignore */
      }
      setStatus(detail);
      setMessages((prev) =>
        prev.map((m, i) =>
          i === assistantIndex
            ? { ...m, content: m.content || `[错误] ${detail}` }
            : m
        )
      );
      setIsStreaming(false);
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let pending = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      const { events, rest } = parseSseBlocks(pending);
      pending = rest;

      for (const ev of events) {
        if (!ev.rawData) continue;
        if (ev.eventName === "token") {
          try {
            const { delta } = JSON.parse(ev.rawData) as { delta?: string };
            const d = delta ?? "";
            setMessages((prev) =>
              prev.map((m, i) =>
                i === assistantIndex
                  ? { ...m, content: `${m.content}${d}` }
                  : m
              )
            );
          } catch {
            /* ignore */
          }
        } else if (ev.eventName === "error") {
          try {
            const { message } = JSON.parse(ev.rawData) as { message?: string };
            setStatus(message ?? "出错");
            setMessages((prev) =>
              prev.map((m, i) =>
                i === assistantIndex
                  ? {
                      ...m,
                      content: m.content
                        ? `${m.content}\n\n[错误] ${message}`
                        : `[错误] ${message}`,
                    }
                  : m
              )
            );
          } catch {
            /* ignore */
          }
        } else if (ev.eventName === "done") {
          setStatus("就绪");
        }
      }
    }

    setIsStreaming(false);
    void loadSession();
  }

  async function handleApplyToWorld() {
    if (isStreaming || isApplying || messages.length === 0) return;
    const ok = window.confirm(
      "将根据当前编剧对话与最新世界版本，生成**合并后的 Canonical**并保存为**新版本**。\n\n请确认对话里已说清楚要做的修改；此操作会消耗模型配额。"
    );
    if (!ok) return;

    setIsApplying(true);
    setApplyHint(null);
    setStatus("正在合并对话并写入新版本…");

    try {
      const res = await fetch(`/api/worlds/${worldId}/screenwriter/apply`, {
        method: "POST",
      });
      const data = (await res.json()) as {
        error?: string;
        errors?: string[];
        version?: { version: number };
        versionsUrl?: string;
        mock?: boolean;
      };

      if (!res.ok) {
        setStatus(data.error ?? "落库失败");
        if (Array.isArray(data.errors) && data.errors.length > 0) {
          setApplyHint(data.errors.join("；"));
        }
        return;
      }

      setUseScratchCreation(false);
      router.replace(`/worlds/${worldId}/workshop`);

      const mockNote = data.mock ? "（Mock 未真实合并，仅复制结构）" : "";
      setStatus(
        `已保存为新版本 v${data.version?.version ?? "?"}${mockNote}。`
      );
      setApplyHint(
        data.versionsUrl ? `可到版本页核对 JSON。` : null
      );
      void loadSession();
    } catch {
      setStatus("落库请求失败");
    } finally {
      setIsApplying(false);
    }
  }

  return (
    <div className="panel" style={{ marginTop: "1rem" }}>
      <h2 style={{ marginTop: 0 }}>与编剧对话</h2>
      <p className="muted">
        世界：<strong>{worldName}</strong>
        {sessionId ? (
          <span className="muted"> · 会话 {sessionId.slice(0, 8)}…</span>
        ) : null}
        <button
          type="button"
          className="link-button"
          style={{ marginLeft: "0.5rem" }}
          onClick={() => void loadSession()}
        >
          刷新历史
        </button>
      </p>
      <p className="muted" style={{ fontSize: "0.85rem" }}>
        {loadStatus} · {status || "使用用户偏好模型；CW_CHAT_MOCK=1 时为演示流"}
      </p>

      <div
        className="row"
        style={{
          flexWrap: "wrap",
          gap: "0.5rem",
          marginTop: "0.75rem",
          alignItems: "center",
        }}
      >
        <button
          type="button"
          className="button primary"
          disabled={
            isStreaming ||
            isApplying ||
            messages.length === 0
          }
          onClick={() => void handleApplyToWorld()}
        >
          {isApplying ? "合并落库中…" : "将对话合并为新版本"}
        </button>
        <Link className="button" href={`/worlds/${worldId}/versions`}>
          查看版本
        </Link>
        <span className="muted" style={{ fontSize: "0.82rem" }}>
          用模型把对话里的修改写入 world_versions；需 API Key。若设{" "}
          <span className="code-inline">CW_WORLD_IMPORT_AGENT=0</span> 将禁止落库。
        </span>
      </div>
      {applyHint ? (
        <p className="muted" style={{ color: "var(--danger)", marginTop: "0.35rem" }}>
          {applyHint}
        </p>
      ) : null}

      <div className="chat-log" style={{ minHeight: "12rem", maxHeight: "28rem", overflowY: "auto" }}>
        {messages.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>
            {useScratchCreation
              ? "可从题材、时代或一句设定想法说起；编剧会分步追问，再点下方「将对话合并为新版本」生成首版。"
              : "例如：「帮我梳理三大势力的矛盾」「给主角设计一条与世界规则冲突的动机」…"}
          </p>
        ) : (
          messages.map((m, i) => (
            <div
              key={`${m.role}-${i}`}
              className={`chat-msg ${
                m.role === "user" ? "chat-msg--user" : "chat-msg--assistant"
              }`}
            >
              <div className="chat-msg-role">
                {m.role === "user" ? "你" : "编剧"}
              </div>
              <div className="chat-msg-body">
                <div className="chat-msg-text">{m.content || (isStreaming && i === messages.length - 1 ? "…" : "")}</div>
              </div>
            </div>
          ))
        )}
      </div>

      <form ref={formRef} onSubmit={handleSubmit} style={{ marginTop: "1rem" }}>
        <label htmlFor="sw-input">消息</label>
        <p className="muted" style={{ fontSize: "0.8rem", margin: "0.25rem 0 0" }}>
          <strong>Enter</strong> 发送，<strong>Shift+Enter</strong> 换行
        </p>
        <textarea
          id="sw-input"
          className="input"
          rows={3}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter" || e.shiftKey) return;
            e.preventDefault();
            if (canSend && formRef.current) {
              formRef.current.requestSubmit();
            }
          }}
          placeholder={
            useScratchCreation
              ? "说说你想做的世界类型、基调或第一个点子…"
              : "描述你想修改或深化的设定…"
          }
          style={{ marginTop: "0.35rem", resize: "vertical" }}
        />
        <button
          type="submit"
          className="button primary"
          style={{ marginTop: "0.65rem" }}
          disabled={!canSend}
        >
          {isStreaming ? "生成中…" : "发送"}
        </button>
      </form>
    </div>
  );
}
