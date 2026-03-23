import Link from "next/link";
import ImportForm from "./import-form";

export default function WorldImportPage() {
  return (
    <main className="page-shell">
      <div className="panel">
        <h1 style={{ marginTop: 0 }}>导入世界书</h1>
        <p className="muted">
          请<strong>上传文件</strong>：<span className="code-inline">.json</span> /{" "}
          <span className="code-inline">.yaml</span> 走规则校验；<span className="code-inline">.md</span> /{" "}
          <span className="code-inline">.txt</span> 等可走 <strong>AI Agent</strong> 结构化后再入库。
          快照写入 <span className="code-inline">source_raw_json</span>。脚本集成见表单底部「高级：JSON API」。
        </p>
        <div className="row">
          <Link className="button" href="/worlds">
            返回世界列表
          </Link>
          <Link className="button" href="/tavern">
            酒馆
          </Link>
        </div>
      </div>
      <ImportForm />
    </main>
  );
}
