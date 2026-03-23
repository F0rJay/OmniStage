export default function SignInPage() {
  return (
    <main className="page-shell">
      <div className="panel" style={{ maxWidth: 480 }}>
        <h1 style={{ marginTop: 0 }}>进入 CanonWeave 酒馆</h1>
        <p className="muted">
          当前为<strong>本地演示登录</strong>，仅用于开发阶段。后续可替换为 Clerk / Auth0
          等正式鉴权。
        </p>
        <form method="post" action="/api/auth/demo-login">
          <label htmlFor="username">称呼 / 显示名</label>
          <input
            id="username"
            name="username"
            className="input"
            placeholder="例如：旅人、酒客"
            required
          />
          <button className="button primary" style={{ marginTop: "1rem" }} type="submit">
            进入酒馆
          </button>
        </form>
      </div>
    </main>
  );
}
