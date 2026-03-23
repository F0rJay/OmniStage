import "server-only";

import { parse as parseYaml } from "yaml";

/** 与 canonical-world 直传 JSON 上限一致 */
export const MAX_IMPORT_FILE_BYTES_JSON_PATH = 512 * 1024;
/** 与 world-import-agent 输入上限一致 */
export const MAX_IMPORT_FILE_BYTES_AGENT_PATH = 256 * 1024;

const EXT = {
  json: /\.json$/i,
  markdown: /\.(md|markdown)$/i,
  text: /\.txt$/i,
  yaml: /\.(ya?ml)$/i,
};

export type ImportFileKind = "json" | "markdown" | "text" | "yaml" | "unknown";

export function detectImportFileKind(fileName: string): ImportFileKind {
  if (EXT.json.test(fileName)) return "json";
  if (EXT.markdown.test(fileName)) return "markdown";
  if (EXT.yaml.test(fileName)) return "yaml";
  if (EXT.text.test(fileName)) return "text";
  return "unknown";
}

/**
 * 非 Agent 路径：YAML 文件先解析为对象再序列化为 JSON 字符串供 Canonical 校验。
 * Agent 路径：保持原文（含 YAML 文本），交给模型理解。
 */
export function prepareRawTextForImport(input: {
  rawText: string;
  fileName: string;
  useAgent: boolean;
}): { ok: true; rawJson: string } | { ok: false; error: string } {
  const enc = new TextEncoder();
  const bytes = enc.encode(input.rawText);
  const max = input.useAgent
    ? MAX_IMPORT_FILE_BYTES_AGENT_PATH
    : MAX_IMPORT_FILE_BYTES_JSON_PATH;
  if (bytes.length > max) {
    return {
      ok: false,
      error: `文件过大（当前 ${bytes.length} 字节，上限 ${max} 字节）。请精简或分段导入。`,
    };
  }

  if (input.useAgent) {
    return { ok: true, rawJson: input.rawText };
  }

  const kind = detectImportFileKind(input.fileName);
  if (kind === "yaml") {
    try {
      const doc = parseYaml(input.rawText) as unknown;
      return { ok: true, rawJson: JSON.stringify(doc) };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, error: `YAML 解析失败：${msg}` };
    }
  }

  if (kind === "markdown" || kind === "text" || kind === "unknown") {
    return {
      ok: false,
      error:
        kind === "unknown"
          ? "无法识别扩展名。规则导入请使用 .json 或 .yaml；Markdown/纯文本请选用「AI 解析」模式。"
          : "Markdown / 纯文本需使用「AI 解析」模式导入，或先转为 Canonical JSON。",
    };
  }

  return { ok: true, rawJson: input.rawText };
}

/** 从文件名生成默认世界名（去扩展名） */
export function defaultWorldNameFromFileName(fileName: string): string {
  const base = fileName.replace(/[/\\]/g, "").trim() || "导入的世界";
  return base.replace(/\.[^.]+$/, "").trim() || "导入的世界";
}
