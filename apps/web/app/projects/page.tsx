import Link from 'next/link';
import { listProjects } from '../../lib/api';
import { Badge } from '../../components/Badge';

export const dynamic = 'force-dynamic';

export default async function ProjectsPage() {
  const projects = await listProjects();
  return (
    <>
      <div className="topline">MVP-2 Report Viewer</div>
      <h1>Projects</h1>
      <p className="lede">등록된 repo와 eval 설정을 기준으로 task, loop, report evidence를 탐색합니다.</p>
      <section className="section grid two">
        {projects.map((project) => (
          <Link key={project.id} href={`/projects/${project.id}`} className="card stack">
            <div className="row">
              <h2>{project.name}</h2>
              <Badge value={project.status} />
            </div>
            <div className="meta">default branch: {project.defaultBranch}</div>
            <div className="meta">eval: {project.evalConfigPath}</div>
            <div className="link">Open project →</div>
          </Link>
        ))}
        {projects.length === 0 ? <div className="empty">등록된 프로젝트가 없습니다.</div> : null}
      </section>
    </>
  );
}
