import { Badge } from '../../components/Badge';
import { listCandidates, listProjects } from '../../lib/api';

export const dynamic = 'force-dynamic';

export default async function CandidatesPage() {
  const projects = await listProjects();
  const projectCandidates = await Promise.all(
    projects.map(async (project) => ({ project, candidates: await listCandidates(project.id) }))
  );
  const hasCandidates = projectCandidates.some(({ candidates }) => candidates.length > 0);

  return (
    <>
      <div className="topline">Supervised candidate queue</div>
      <h1>Improvement Candidates</h1>
      <p className="lede">자동 발견 후보를 승인해 deterministic task.yaml로 바꾸거나 dismiss합니다.</p>
      <section className="section stack">
        {projectCandidates.map(({ project, candidates }) => (
          <div key={project.id} className="card stack">
            <div className="row">
              <div>
                <h2>{project.name}</h2>
                <div className="meta">{project.localPath ?? project.repoUrl ?? 'repo not configured'}</div>
              </div>
              <Badge value={project.status} />
            </div>
            {candidates.map((candidate) => (
              <div key={candidate.id} className="card compact stack">
                <div className="row">
                  <div>
                    <strong>{candidate.title}</strong>
                    <div className="meta">
                      {candidate.source} · priority {candidate.priority} · {candidate.fingerprint.slice(0, 12)}
                    </div>
                  </div>
                  <Badge value={candidate.status} />
                </div>
                <div className="meta">risk: {candidate.riskAreaHint ?? 'unknown'} / task: {candidate.taskId ?? 'not generated'}</div>
                <form className="row" method="post" action={`/api/candidates/${candidate.id}/approve`}>
                  <input className="input" name="reason" placeholder="dismiss reason" />
                  <button className="button" type="submit">Approve</button>
                  <button className="button danger" type="submit" formAction={`/api/candidates/${candidate.id}/dismiss`}>
                    Dismiss
                  </button>
                </form>
              </div>
            ))}
            {candidates.length === 0 ? <div className="empty">candidate가 없습니다.</div> : null}
          </div>
        ))}
        {!hasCandidates && projects.length === 0 ? <div className="empty">등록된 프로젝트가 없습니다.</div> : null}
      </section>
    </>
  );
}
