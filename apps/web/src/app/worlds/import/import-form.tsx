"use client";

import Link from "next/link";
import {
  FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

const ACCEPT =
  ".json,.yaml,.yml,.md,.markdown,.txt,application/json,text/markdown,text/plain,text/yaml";

type ImportMode = "json" | "agent";

function validateFileAgainstMode(
  file: File,
  importMode: ImportMode
): string | null {
  const n = file.name.toLowerCase();
  if (importMode === "json") {
    if (n.endsWith(".md") || n.endsWith(".markdown") || n.endsWith(".txt")) {
      return "当前为「规则校验」模式：请上传 .json 或 .yaml，或切换到「AI 解析」以导入 Markdown/纯文本。";
    }
    if (!/\.(json|ya?ml)$/.test(n)) {
      return "规则模式仅支持 .json、.yaml、.yml；其他格式请用「AI 解析」。";
    }
  }
  return null;
}

export default function ImportForm() {
  const [importMode, setImportMode] = useState<ImportMode>("json");
  const [file, setFile] = useState<File | null>(null);
  const [worldName, setWorldName] = useState("");
  const [worldId, setWorldId] = useState("");
  const [status, setStatus] = useState("");
  const [errors, setErrors] = useState<string[]>([]);
  const [versionsUrl, setVersionsUrl] = useState<string | null>(null);
  const [modelOptions, setModelOptions] = useState<
    Array<{ provider: string; modelId: string; label: string }>
  >([]);
  const [importModel, setImportModel] = useState("");
  const [modelStatus, setModelStatus] = useState("");
  const [autoEnrichCharacterBooks, setAutoEnrichCharacterBooks] = useState(true);
  const [dragOver, setDragOver] = useState(false);
  const [worldOptions, setWorldOptions] = useState<Array<{ id: string; name: string }>>([]);
  const [worldOptionsStatus, setWorldOptionsStatus] = useState("加载已有世界…");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void (async () => {
      const res = await fetch("/api/models");
      if (!res.ok) {
        setModelStatus("模型列表加载失败");
        return;
      }
      const data = (await res.json()) as {
        models: Array<{ provider: string; modelId: string; label: string }>;
      };
      setModelOptions(data.models ?? []);
      if (data.models?.[0]) {
        setImportModel(`${data.models[0].provider}::${data.models[0].modelId}`);
      }
      setModelStatus(`${(data.models ?? []).length} 个模型可选`);
    })();
  }, []);

  useEffect(() => {
    void (async () => {
      const res = await fetch("/api/worlds?limit=100");
      if (!res.ok) {
        setWorldOptionsStatus("已有世界加载失败");
        return;
      }
      const data = (await res.json()) as {
        worlds?: Array<{ id: string; name: string }>;
      };
      const rows = Array.isArray(data.worlds) ? data.worlds : [];
      setWorldOptions(rows.map((w) => ({ id: w.id, name: w.name })));
      setWorldOptionsStatus(rows.length > 0 ? `可选 ${rows.length} 个已有世界` : "暂无已有世界");
    })();
  }, []);

  const useAgent = importMode === "agent";

  const assignFile = useCallback((next: File | null) => {
    setFile(next);
    setErrors([]);
    setVersionsUrl(null);
    setStatus("");
    if (next && !worldId.trim()) {
      const stem = next.name.replace(/\.[^.]+$/, "").trim() || "导入的世界";
      setWorldName(stem);
    }
  }, [worldId]);

  const canSubmit = useMemo(() => {
    if (!file) return false;
    if (useAgent && !importModel.includes("::")) return false;
    return true;
  }, [file, useAgent, importModel]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setErrors([]);
    setVersionsUrl(null);

    if (!file) {
      setStatus("请先选择或拖入世界书文件。");
      return;
    }

    const modeErr = validateFileAgainstMode(file, importMode);
    if (modeErr) {
      setStatus(modeErr);
      return;
    }

    if (useAgent && !importModel.includes("::")) {
      setStatus("请选择用于解析的模型。");
      return;
    }

    setStatus(
      useAgent ? "AI 解析并校验中（可能需数十秒）…" : "校验并写入中…"
    );

    const fd = new FormData();
    fd.append("file", file);
    fd.append("useAgent", useAgent ? "true" : "false");
    if (worldId.trim()) {
      fd.append("worldId", worldId.trim());
    } else {
      fd.append("worldName", (worldName.trim() || "导入的世界"));
    }
    if (useAgent && importModel.includes("::")) {
      const [p, m] = importModel.split("::");
      if (p && m) {
        fd.append("modelProvider", p);
        fd.append("modelId", m);
      }
      fd.append(
        "autoEnrichCharacterBooks",
        autoEnrichCharacterBooks ? "true" : "false"
      );
    }

    const response = await fetch("/api/worlds/import", {
      method: "POST",
      body: fd,
    });

    const data = (await response.json()) as {
      error?: string;
      errors?: string[];
      versionsUrl?: string;
      version?: { version: number };
      agentUsed?: boolean;
      fileName?: string;
    };

    if (!response.ok) {
      setStatus(data.error ?? "导入失败。");
      if (Array.isArray(data.errors)) setErrors(data.errors);
      return;
    }

    const via = data.agentUsed ? "（经 AI 解析）" : "";
    setStatus(
      `已保存「${data.fileName ?? file.name}」为版本 v${data.version?.version ?? "?"}${via}。`
    );
    if (data.versionsUrl) setVersionsUrl(data.versionsUrl);
  }

  function switchMode(next: ImportMode) {
    setImportMode(next);
    setErrors([]);
    setVersionsUrl(null);
    setStatus("");
  }

  function clearFile() {
    assignFile(null);
    if (inputRef.current) inputRef.current.value = "";
  }

  return (
    <form className="panel" style={{ marginTop: "1rem" }} onSubmit={handleSubmit}>
      <h2 style={{ marginTop: 0 }}>导入方式</h2>
      <div className="row" style={{ flexWrap: "wrap", gap: "0.5rem" }}>
        <button
          type="button"
          className={importMode === "json" ? "button primary" : "button"}
          onClick={() => switchMode("json")}
        >
          规则：JSON / YAML
        </button>
        <button
          type="button"
          className={importMode === "agent" ? "button primary" : "button"}
          onClick={() => switchMode("agent")}
        >
          AI 解析：Markdown / 文本 / 任意稿
        </button>
      </div>
      <p className="muted" style={{ marginTop: "0.65rem" }}>
        {importMode === "json" ? (
          <>
            上传 <span className="code-inline">.json</span> 或{" "}
            <span className="code-inline">.yaml / .yml</span>
            （服务端将 YAML 转为 JSON 后做 Canonical 校验），不调用模型。
          </>
        ) : (
          <>
            上传 <span className="code-inline">.md</span>、<span className="code-inline">.txt</span>、
            <span className="code-inline">.json</span> 等，由 AI 结构化后再校验；可选“自动补全角色卡”。
          </>
        )}
      </p>

      {importMode === "agent" ? (
        <div style={{ marginTop: "1rem" }}>
          <label htmlFor="import-model">解析所用模型</label>
          <select
            id="import-model"
            className="input"
            value={importModel}
            onChange={(e) => setImportModel(e.target.value)}
            style={{ marginTop: "0.35rem" }}
          >
            {modelOptions.map((opt) => {
              const v = `${opt.provider}::${opt.modelId}`;
              return (
                <option key={v} value={v}>
                  {opt.label} ({opt.provider}/{opt.modelId})
                </option>
              );
            })}
          </select>
          <p className="muted" style={{ marginBottom: 0 }}>
            {modelStatus} · 建议选用支持结构化输出的模型。
          </p>
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: "0.45rem",
              marginTop: "0.55rem",
            }}
          >
            <input
              type="checkbox"
              checked={autoEnrichCharacterBooks}
              onChange={(e) => setAutoEnrichCharacterBooks(e.target.checked)}
            />
            导入后自动补全角色卡（把角色实体尽量写入人物书）
          </label>
        </div>
      ) : null}

      <h3 style={{ marginTop: "1.25rem", marginBottom: "0.35rem" }}>
        世界书文件
      </h3>
      <div
        className="import-dropzone"
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          const f = e.dataTransfer.files[0];
          if (f) assignFile(f);
        }}
        style={{
          marginTop: "0.35rem",
          padding: "1.25rem 1rem",
          borderRadius: "var(--radius-sm)",
          border: `2px dashed ${dragOver ? "var(--primary)" : "var(--border)"}`,
          background: dragOver ? "var(--accent-dim)" : "var(--bg-input)",
          textAlign: "center",
        }}
      >
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPT}
          style={{ display: "none" }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) assignFile(f);
          }}
        />
        <p style={{ margin: "0 0 0.65rem", color: "var(--text-muted)" }}>
          拖放文件到此处，或
        </p>
        <button
          type="button"
          className="button"
          onClick={() => inputRef.current?.click()}
        >
          选择文件
        </button>
        <p className="muted" style={{ margin: "0.65rem 0 0", fontSize: "0.82rem" }}>
          支持：JSON、YAML、Markdown、纯文本（后两者需「AI 解析」模式）
        </p>
      </div>

      {file ? (
        <p style={{ marginTop: "0.75rem", marginBottom: 0 }}>
          <strong>已选：</strong> {file.name}{" "}
          <span className="muted">（{(file.size / 1024).toFixed(1)} KB）</span>{" "}
          <button type="button" className="link-button" onClick={clearFile}>
            清除
          </button>
        </p>
      ) : null}

      <div
        style={{
          marginTop: "1rem",
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
          gap: "0.85rem",
          alignItems: "start",
        }}
      >
        <div>
          <label htmlFor="world-name">新世界名称（追加到已有世界时可不填）</label>
          <input
            id="world-name"
            className="input"
            value={worldName}
            onChange={(e) => setWorldName(e.target.value)}
            disabled={Boolean(worldId.trim())}
            placeholder="可从文件名推断"
            style={{ marginTop: "0.35rem" }}
          />
        </div>
        <div>
          <label htmlFor="world-id">已有世界（可选）</label>
          <select
            id="world-id"
            className="input"
            value={worldId}
            onChange={(e) => {
              setWorldId(e.target.value);
              if (e.target.value.trim()) setWorldName("");
            }}
            style={{ marginTop: "0.35rem" }}
          >
            <option value="">留空则创建新世界</option>
            {worldOptions.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
          <p className="muted" style={{ marginBottom: 0 }}>
            {worldOptionsStatus}
          </p>
        </div>
      </div>

      <div className="row" style={{ marginTop: "0.75rem" }}>
        <button type="submit" className="button primary" disabled={!canSubmit}>
          {importMode === "agent" ? "上传并 AI 解析" : "上传并校验保存"}
        </button>
        <span className="muted">{status}</span>
      </div>

      <details style={{ marginTop: "1rem" }} className="muted">
        <summary style={{ cursor: "pointer" }}>高级：JSON API（自动化 / 脚本）</summary>
        <p style={{ marginTop: "0.5rem", fontSize: "0.85rem" }}>
          <span className="code-inline">POST /api/worlds/import</span> 仍支持{" "}
          <span className="code-inline">application/json</span>，字段{" "}
          <span className="code-inline">rawJson</span>、<span className="code-inline">useAgent</span>、
          <span className="code-inline">fileName</span>（建议带上原始文件名以便 YAML/扩展名判断）。
        </p>
      </details>

      {errors.length > 0 ? (
        <ul className="muted" style={{ color: "var(--danger)", marginTop: "0.75rem" }}>
          {errors.map((err) => (
            <li key={err}>{err}</li>
          ))}
        </ul>
      ) : null}

      {versionsUrl ? (
        <p style={{ marginTop: "0.75rem", marginBottom: 0 }}>
          <Link className="button primary" href={versionsUrl}>
            查看版本列表
          </Link>
        </p>
      ) : null}
    </form>
  );
}
