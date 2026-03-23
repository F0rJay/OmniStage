import type { Metadata } from "next";
import Link from "next/link";
import { Noto_Sans_SC } from "next/font/google";
import "./globals.css";

const notoSans = Noto_Sans_SC({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "CanonWeave · 单人酒馆",
  description: "AI 角色扮演：酒馆会话、世界书与流式对话",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body className={notoSans.className}>
        <header className="site-header">
          <div className="site-header-inner">
            <Link href="/tavern" className="site-logo">
              CanonWeave <span>酒馆</span>
            </Link>
            <nav className="site-nav" aria-label="主导航">
              <Link href="/tavern">酒馆</Link>
              <Link href="/tavern/characters">角色</Link>
              <Link href="/worlds">世界书</Link>
              <Link href="/worlds/import">导入</Link>
              <Link href="/profile">偏好</Link>
              <Link href="/sign-in">登录</Link>
            </nav>
          </div>
        </header>
        {children}
      </body>
    </html>
  );
}
