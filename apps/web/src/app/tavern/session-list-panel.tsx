"use client";

import Link from "next/link";
import { useCallback, useMemo, useState } from "react";

type ThreadItem = {
  id: string;
  title: string;
  model_provider: string;
  model_id: string;
  world_version_id?: string | null;
  archived_at: string | null;
  updated_at: string;
};

type ModelOption = {
  provider: string;
  modelId: string;
  label: string;
};

type Props = {
  initialThreads: ThreadItem[];
  initialTotal: number;
  pageSize?: number;
  modelOptions: ModelOption[];
};

function modelValue(provider: string, modelId: string): string {
  return `${provider}::${modelId}`;
}

export default function SessionListPanel({
  initialThreads,
  initialTotal,
  pageSize = 10,
  modelOptions,
}: Props) {
  const [threads, setThreads] = useState<ThreadItem[]>(initialThreads);
  const [total, setTotal] = useState(initialTotal);
  const [page, setPage] = useState(0);
  const [filterModel, setFilterModel] = useState("all");
  const [archivedScope, setArchivedScope] = useState<"active" | "archived" | "all">(
    "active"
  );
  const [searchDraft, setSearchDraft] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [renameInputByThread, setRenameInputByThread] = useState<Record<string, string>>(
    {}
  );
  const [status, setStatus] = useState("就绪");

  const pageCount = Math.max(1, Math.ceil(total / pageSize));

  const modelLabelMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const item of modelOptions) {
      map.set(modelValue(item.provider, item.modelId), item.label);
    }
    return map;
  }, [modelOptions]);

  const buildQueryString = useCallback(
    (opts: {
      filter: string;
      archived: typeof archivedScope;
      q: string;
      pageIndex: number;
    }) => {
      const params = new URLSearchParams();
      params.set("limit", String(pageSize));
      params.set("offset", String(opts.pageIndex * pageSize));
      params.set("archived", opts.archived);
      if (opts.q.trim()) {
        params.set("q", opts.q.trim());
      }
      if (opts.filter !== "all") {
        const [provider, modelId] = opts.filter.split("::");
        if (provider && modelId) {
          params.set("provider", provider);
          params.set("modelId", modelId);
        }
      }
      return params.toString();
    },
    [pageSize]
  );

  const reloadThreads = useCallback(
    async (opts: {
      filter?: string;
      archived?: typeof archivedScope;
      q?: string;
      pageIndex?: number;
    }) => {
      const filter = opts.filter ?? filterModel;
      const archived = opts.archived ?? archivedScope;
      const q = opts.q ?? searchQuery;
      const pageIndex = opts.pageIndex ?? page;

      setStatus("加载会话…");
      const qs = buildQueryString({ filter, archived, q, pageIndex });
      const response = await fetch(`/api/threads?${qs}`);
      if (!response.ok) {
        setStatus("加载失败。");
        return;
      }
      const payload = (await response.json()) as {
        threads: ThreadItem[];
        total: number;
        limit: number;
        offset: number;
      };
      setThreads(payload.threads);
      setTotal(payload.total);
      setStatus(
        `本页 ${payload.threads.length} 条，共 ${payload.total} 条（偏移 ${payload.offset}）`
      );
    },
    [archivedScope, buildQueryString, filterModel, page, searchQuery]
  );

  async function handleFilterChange(nextFilter: string) {
    setFilterModel(nextFilter);
    setPage(0);
    await reloadThreads({ filter: nextFilter, pageIndex: 0 });
  }

  async function handleArchivedScopeChange(next: typeof archivedScope) {
    setArchivedScope(next);
    setPage(0);
    await reloadThreads({ archived: next, pageIndex: 0 });
  }

  async function handleSearchSubmit() {
    setSearchQuery(searchDraft);
    setPage(0);
    await reloadThreads({ q: searchDraft, pageIndex: 0 });
  }

  async function goToPage(nextPage: number) {
    const clamped = Math.min(Math.max(0, nextPage), pageCount - 1);
    setPage(clamped);
    await reloadThreads({ pageIndex: clamped });
  }

  async function handleRename(threadId: string) {
    const nextTitle = (renameInputByThread[threadId] ?? "").trim();
    if (!nextTitle) return;

    setStatus("重命名中…");
    const response = await fetch(`/api/threads/${threadId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: nextTitle }),
    });
    if (!response.ok) {
      setStatus("重命名失败。");
      return;
    }

    setThreads((prev) =>
      prev.map((item) => (item.id === threadId ? { ...item, title: nextTitle } : item))
    );
    setStatus("已保存标题。");
  }

  async function handleArchive(threadId: string) {
    setStatus("归档中…");
    const response = await fetch(`/api/threads/${threadId}`, { method: "DELETE" });
    if (!response.ok) {
      setStatus("归档失败。");
      return;
    }
    await reloadThreads({});
  }

  async function handleRestore(threadId: string) {
    setStatus("恢复中…");
    const response = await fetch(`/api/threads/${threadId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ archived: false }),
    });
    if (!response.ok) {
      setStatus("恢复失败。");
      return;
    }
    await reloadThreads({});
  }

  async function handlePermanentDelete(threadId: string, title: string) {
    const ok = window.confirm(
      `永久删除会话「${title.slice(0, 48)}${title.length > 48 ? "…" : ""}」？\n\n将删除所有消息、事件与关联会话洞察，不可恢复。`
    );
    if (!ok) return;

    setStatus("删除中…");
    const response = await fetch(`/api/threads/${threadId}/permanent`, {
      method: "DELETE",
    });
    if (!response.ok) {
      let detail = "删除失败";
      try {
        const j = (await response.json()) as { error?: string };
        if (j.error) detail = j.error;
      } catch {
        /* ignore */
      }
      setStatus(detail);
      return;
    }
    setStatus("已永久删除。");
    await reloadThreads({});
  }

  return (
    <div className="panel" style={{ marginTop: "1rem" }}>
      <h2 style={{ marginTop: 0 }}>最近会话</h2>
      <p className="muted" style={{ marginTop: "-0.25rem", marginBottom: "0.75rem" }}>
        <strong>归档</strong>可恢复；<strong style={{ color: "var(--danger, #c44)" }}>永久删除</strong>
        将清除消息与事件且不可恢复。
      </p>

      <div className="row" style={{ marginBottom: "0.75rem", alignItems: "flex-end" }}>
        <div style={{ flex: "1 1 220px" }}>
          <label htmlFor="session-search">按标题搜索</label>
          <input
            id="session-search"
            className="input"
            value={searchDraft}
            onChange={(e) => setSearchDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleSearchSubmit();
            }}
            placeholder="支持子串匹配…"
            style={{ marginTop: "0.35rem" }}
          />
        </div>
        <button type="button" className="button primary" onClick={handleSearchSubmit}>
          搜索
        </button>
      </div>

      <div className="row" style={{ marginBottom: "0.75rem" }}>
        <div style={{ flex: "1 1 200px" }}>
          <label htmlFor="session-model-filter">按模型筛选</label>
          <select
            id="session-model-filter"
            className="input"
            value={filterModel}
            onChange={(event) => {
              void handleFilterChange(event.target.value);
            }}
            style={{ marginTop: "0.35rem" }}
          >
            <option value="all">全部模型</option>
            {modelOptions.map((option) => {
              const value = modelValue(option.provider, option.modelId);
              return (
                <option key={value} value={value}>
                  {option.label}
                </option>
              );
            })}
          </select>
        </div>
        <div style={{ flex: "1 1 200px" }}>
          <label htmlFor="session-archived-scope">范围</label>
          <select
            id="session-archived-scope"
            className="input"
            value={archivedScope}
            onChange={(event) => {
              void handleArchivedScopeChange(event.target.value as typeof archivedScope);
            }}
            style={{ marginTop: "0.35rem" }}
          >
            <option value="active">仅进行中</option>
            <option value="archived">仅已归档</option>
            <option value="all">全部</option>
          </select>
        </div>
        <span className="muted" style={{ alignSelf: "center" }}>
          {status}
        </span>
      </div>

      <div className="row" style={{ marginBottom: "0.9rem" }}>
        <button
          type="button"
          className="button"
          disabled={page <= 0}
          onClick={() => goToPage(page - 1)}
        >
          上一页
        </button>
        <span className="muted">
          第 {page + 1} / {pageCount} 页 · 共 {total} 条
        </span>
        <button
          type="button"
          className="button"
          disabled={page >= pageCount - 1}
          onClick={() => goToPage(page + 1)}
        >
          下一页
        </button>
      </div>

      {threads.length === 0 ? (
        <p className="muted" style={{ margin: 0 }}>
          没有符合条件的会话，试试调整筛选或搜索。
        </p>
      ) : (
        <div className="thread-list">
          {threads.map((thread) => {
            const currentInput = renameInputByThread[thread.id] ?? thread.title;
            const modelKey = modelValue(thread.model_provider, thread.model_id);
            const modelLabel = modelLabelMap.get(modelKey) ?? modelKey;
            const isArchived = Boolean(thread.archived_at);
            return (
              <div key={thread.id} className="thread-item">
                <div className="thread-item-head">
                  <div className="row" style={{ flexWrap: "nowrap" }}>
                    <Link className="button" href={`/tavern/sessions/${thread.id}`}>
                      进入
                    </Link>
                    {isArchived ? (
                      <span className="tag tag-muted">已归档</span>
                    ) : null}
                  </div>
                  <span className="muted">{modelLabel}</span>
                </div>
                <input
                  className="input"
                  value={currentInput}
                  onChange={(event) =>
                    setRenameInputByThread((prev) => ({
                      ...prev,
                      [thread.id]: event.target.value,
                    }))
                  }
                  style={{ marginTop: "0.5rem" }}
                />
                <div className="row" style={{ marginTop: "0.5rem" }}>
                  <button
                    type="button"
                    className="button"
                    onClick={() => {
                      void handleRename(thread.id);
                    }}
                  >
                    保存标题
                  </button>
                  {isArchived ? (
                    <button
                      type="button"
                      className="button"
                      onClick={() => {
                        void handleRestore(thread.id);
                      }}
                    >
                      恢复
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="button"
                      onClick={() => {
                        void handleArchive(thread.id);
                      }}
                    >
                      归档
                    </button>
                  )}
                  <button
                    type="button"
                    className="button"
                    onClick={() => {
                      void handlePermanentDelete(thread.id, thread.title);
                    }}
                    style={{
                      borderColor: "var(--danger, #c44)",
                      color: "var(--danger, #c44)",
                    }}
                  >
                    永久删除
                  </button>
                  <span className="muted">更新：{thread.updated_at}</span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
