import './globals.css';
import Link from 'next/link';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'VibeLoop Report Viewer',
  description: 'Read VibeLoop loop evidence, gates, events, and approvals.'
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body>
        <div className="shell">
          <aside className="sidebar">
            <div className="brand">VibeLoop</div>
            <p>AI 변경은 PR 전에 증거로 판정됩니다. 이 웹은 실행을 트리거하지 않고 결과를 보여줍니다.</p>
            <nav className="nav" aria-label="Primary">
              <Link href="/projects">Projects</Link>
              <Link href="/approvals">Approvals</Link>
            </nav>
          </aside>
          <main className="main">{children}</main>
        </div>
      </body>
    </html>
  );
}
