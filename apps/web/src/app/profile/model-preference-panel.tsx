"use client";

import { useEffect, useMemo, useState } from "react";

type ModelOption = {
  provider: string;
  modelId: string;
  label: string;
};

type Props = {
  initialModel: {
    provider: string;
    modelId: string;
  };
  modelOptions: ModelOption[];
};

type EndpointItem = {
  id: string;
  name: string;
  providerType: string;
  baseUrl: string;
  modelId: string;
  updatedAt: string;
};

const PRESET_PROVIDERS: Array<{
  id: string;
  name: string;
  baseUrl: string;
  modelId: string;
}> = [
  {
    id: "deepseek",
    name: "DeepSeek 官方",
    baseUrl: "https://api.deepseek.com/v1",
    modelId: "deepseek-chat",
  },
  {
    id: "qwen-bailian",
    name: "Qwen（阿里百炼）",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    modelId: "qwen-plus",
  },
  {
    id: "kimi",
    name: "Kimi（月之暗面）",
    baseUrl: "https://api.moonshot.cn/v1",
    modelId: "moonshot-v1-8k",
  },
  {
    id: "gemini",
    name: "Gemini（OpenAI 兼容）",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/",
    modelId: "gemini-2.0-flash",
  },
];

export default function ModelPreferencePanel({ initialModel, modelOptions }: Props) {
  const [availableModels, setAvailableModels] = useState<ModelOption[]>(modelOptions);
  const [selectedModel, setSelectedModel] = useState(
    `${initialModel.provider}::${initialModel.modelId}`
  );
  const [status, setStatus] = useState("就绪");
  const [endpoints, setEndpoints] = useState<EndpointItem[]>([]);
  const [endpointStatus, setEndpointStatus] = useState("就绪");
  const [epName, setEpName] = useState("");
  const [epBaseUrl, setEpBaseUrl] = useState("");
  const [epApiKey, setEpApiKey] = useState("");
  const [epModelId, setEpModelId] = useState("");

  const selectedExists = useMemo(
    () =>
      availableModels.some(
        (x) => `${x.provider}::${x.modelId}` === selectedModel
      ),
    [availableModels, selectedModel]
  );

  useEffect(() => {
    void refreshEndpointsAndModels();
  }, []);

  async function refreshEndpointsAndModels() {
    const [epRes, modelsRes] = await Promise.all([
      fetch("/api/users/model-endpoints"),
      fetch("/api/models"),
    ]);
    if (epRes.ok) {
      const ep = (await epRes.json()) as { items?: EndpointItem[] };
      setEndpoints(Array.isArray(ep.items) ? ep.items : []);
    }
    if (modelsRes.ok) {
      const m = (await modelsRes.json()) as { models?: ModelOption[] };
      if (Array.isArray(m.models) && m.models.length > 0) {
        setAvailableModels(m.models);
        if (!selectedExists) {
          const first = m.models[0]!;
          setSelectedModel(`${first.provider}::${first.modelId}`);
        }
      }
    }
  }

  async function handleSave() {
    const [provider, modelId] = selectedModel.split("::");
    if (!provider || !modelId) return;

    setStatus("保存中…");
    const response = await fetch("/api/users/preferences/model", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider, modelId }),
    });

    if (!response.ok) {
      setStatus("保存失败，请重试。");
      return;
    }
    setStatus("已保存。新会话将默认使用该模型。");
  }

  return (
    <div className="panel" style={{ marginTop: "1rem" }}>
      <h2 style={{ marginTop: 0 }}>新会话默认模型</h2>
      <label htmlFor="default-model-select">模型</label>
      <select
        id="default-model-select"
        className="input"
        value={selectedModel}
        onChange={(event) => setSelectedModel(event.target.value)}
      >
        {availableModels.map((option) => {
          const value = `${option.provider}::${option.modelId}`;
          return (
            <option key={value} value={value}>
              {option.label}
            </option>
          );
        })}
      </select>
      <div className="row" style={{ marginTop: "0.8rem" }}>
        <button type="button" className="button primary" onClick={handleSave}>
          保存默认模型
        </button>
        <span className="muted">{status}</span>
      </div>

      <hr style={{ margin: "1rem 0", borderColor: "var(--border)" }} />
      <h3 style={{ marginTop: 0 }}>自定义 OpenAI 兼容接口</h3>
      <p className="muted" style={{ marginTop: 0 }}>
        适用于 SiliconFlow、OpenRouter、本地 vLLM、OneAPI 等 OpenAI 兼容服务。
      </p>
      <div
        className="row"
        style={{
          marginTop: "0.35rem",
          flexWrap: "wrap",
          gap: "0.45rem",
          marginBottom: "0.55rem",
        }}
      >
        {PRESET_PROVIDERS.map((p) => (
          <button
            key={p.id}
            type="button"
            className="button secondary"
            style={{ fontSize: "0.82rem", padding: "0.28rem 0.55rem" }}
            onClick={() => {
              setEpName(p.name);
              setEpBaseUrl(p.baseUrl);
              setEpModelId(p.modelId);
              setEndpointStatus(`已套用预设：${p.name}，请填写 API Key 后保存。`);
            }}
          >
            预设：{p.name}
          </button>
        ))}
      </div>

      <label htmlFor="ep-name">名称</label>
      <input
        id="ep-name"
        className="input"
        placeholder="例如：OpenRouter 主账号"
        value={epName}
        onChange={(e) => setEpName(e.target.value)}
      />
      <label htmlFor="ep-base" style={{ marginTop: "0.5rem", display: "block" }}>
        Base URL（需含 /v1）
      </label>
      <input
        id="ep-base"
        className="input"
        placeholder="https://openrouter.ai/api/v1"
        value={epBaseUrl}
        onChange={(e) => setEpBaseUrl(e.target.value)}
      />
      <label htmlFor="ep-key" style={{ marginTop: "0.5rem", display: "block" }}>
        API Key
      </label>
      <input
        id="ep-key"
        className="input"
        type="password"
        placeholder="sk-..."
        value={epApiKey}
        onChange={(e) => setEpApiKey(e.target.value)}
      />
      <label htmlFor="ep-model" style={{ marginTop: "0.5rem", display: "block" }}>
        默认模型 ID
      </label>
      <input
        id="ep-model"
        className="input"
        placeholder="gpt-4o-mini / deepseek-chat / qwen-plus ..."
        value={epModelId}
        onChange={(e) => setEpModelId(e.target.value)}
      />
      <div className="row" style={{ marginTop: "0.6rem" }}>
        <button
          type="button"
          className="button"
          onClick={async () => {
            setEndpointStatus("保存中…");
            const res = await fetch("/api/users/model-endpoints", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                name: epName,
                baseUrl: epBaseUrl,
                apiKey: epApiKey,
                modelId: epModelId,
              }),
            });
            if (!res.ok) {
              const d = (await res.json().catch(() => ({}))) as { error?: string };
              setEndpointStatus(d.error || "保存失败");
              return;
            }
            setEpApiKey("");
            setEndpointStatus("已保存。可在上方模型列表中选择。");
            await refreshEndpointsAndModels();
          }}
        >
          新增接口
        </button>
        <span className="muted">{endpointStatus}</span>
      </div>

      {endpoints.length > 0 ? (
        <div style={{ marginTop: "0.8rem" }}>
          <h4 style={{ marginBottom: "0.35rem" }}>已保存接口</h4>
          <ul style={{ margin: 0, paddingLeft: "1.2rem" }}>
            {endpoints.map((ep) => (
              <li key={ep.id} style={{ marginBottom: "0.35rem" }}>
                <span>
                  {ep.name} · {ep.baseUrl} · {ep.modelId}
                </span>
                <button
                  type="button"
                  className="button secondary"
                  style={{ marginLeft: "0.5rem", padding: "0.2rem 0.45rem" }}
                  onClick={async () => {
                    await fetch(`/api/users/model-endpoints?id=${ep.id}`, {
                      method: "DELETE",
                    });
                    setEndpointStatus("已删除。");
                    await refreshEndpointsAndModels();
                  }}
                >
                  删除
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
