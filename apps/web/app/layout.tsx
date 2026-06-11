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
            <p>AI 변경은 PR 전에 증거로 판정됩니다. 이 웹은 결과와 자율 루프 제어를 제공합니다.</p>
            <nav className="nav" aria-label="Primary">
              <Link href="/projects">Projects</Link>
              <Link href="/approvals">Approvals</Link>
              <Link href="/candidates">Candidates</Link>
              <Link href="/orchestrator">Orchestrator</Link>
            </nav>
          </aside>
          <main className="main">{children}</main>
        </div>
      </body>
    </html>
  );
}
