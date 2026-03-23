import Link from "next/link";

export default function NotFound() {
  return (
    <main className="page-shell">
      <div className="panel">
        <h1 style={{ marginTop: 0 }}>页面未找到</h1>
        <p className="muted">该地址不存在，或你没有权限查看。</p>
        <div className="row">
          <Link className="button primary" href="/tavern">
            回酒馆
          </Link>
          <Link className="button" href="/worlds">
            世界书
          </Link>
        </div>
      </div>
    </main>
  );
}
