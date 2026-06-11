import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="card stack">
      <div className="topline">404</div>
      <h1>Not found</h1>
      <p className="lede">요청한 프로젝트 또는 loop를 찾을 수 없습니다.</p>
      <Link className="link" href="/projects">Projects로 돌아가기</Link>
    </div>
  );
}
