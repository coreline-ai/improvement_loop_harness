import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ApiError, getProject, listLoops, listTasks } from '../../../lib/api';
import { Badge } from '../../../components/Badge';

export const dynamic = 'force-dynamic';

export default async function ProjectDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const project = await getProject(id);
    const tasks = await listTasks(project.id);
    const taskLoops = await Promise.all(tasks.map(async (task) => ({ task, loops: await listLoops(task.id) })));

    return (
      <>
        <div className="topline">Project</div>
        <h1>{project.name}</h1>
        <p className="lede">Task별 실행 상태와 결정 결과를 확인합니다. 실행 트리거는 CLI/서버 큐가 담당합니다.</p>
        <section className="section card grid three">
          <div><div className="meta">repo</div><strong>{project.localPath ?? project.repoUrl ?? 'not configured'}</strong></div>
          <div><div className="meta">default branch</div><strong>{project.defaultBranch}</strong></div>
          <div><div className="meta">status</div><Badge value={project.status} /></div>
        </section>
        <section className="section stack">
          {taskLoops.map(({ task, loops }) => (
            <div key={task.id} className="card stack">
              <div className="row">
                <div>
                  <h2>{task.title}</h2>
                  <div className="meta">{task.objective}</div>
                </div>
                <Badge value={task.status} />
              </div>
              <table className="table">
                <thead><tr><th>Loop</th><th>Status</th><th>Decision</th><th>Created</th><th>Links</th></tr></thead>
                <tbody>
                  {loops.map((loop) => (
                    <tr key={loop.id}>
                      <td className="code">{loop.id}</td>
                      <td><Badge value={loop.status} /></td>
                      <td><Badge value={loop.decision ?? loop.status} /></td>
                      <td className="meta">{new Date(loop.createdAt).toLocaleString()}</td>
                      <td><Link className="link" href={`/loops/${loop.id}`}>details</Link> · <Link className="link" href={`/loops/${loop.id}/report`}>report</Link></td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {loops.length === 0 ? <div className="empty">아직 loop 실행 기록이 없습니다.</div> : null}
            </div>
          ))}
          {taskLoops.length === 0 ? <div className="empty">등록된 task가 없습니다.</div> : null}
        </section>
      </>
    );
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) notFound();
    throw error;
  }
}
