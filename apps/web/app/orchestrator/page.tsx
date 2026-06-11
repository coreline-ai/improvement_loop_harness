import { Badge } from '../../components/Badge';
import { getOrchestrator, listProjects } from '../../lib/api';

export const dynamic = 'force-dynamic';

export default async function OrchestratorPage() {
  const projects = await listProjects();
  const summaries = await Promise.all(
    projects.map(async (project) => ({ project, summary: await getOrchestrator(project.id) }))
  );

  return (
    <>
      <div className="topline">Autonomous improvement loop</div>
      <h1>Loop Orchestrator</h1>
      <p className="lede">
        candidate 큐를 1개씩 순차 실행하고, 고정 결과지를 통과한 변경만 Draft PR로 넘기는 MVP-4 제어판입니다.
      </p>
      <section className="section stack">
        {summaries.map(({ project, summary }) => (
          <div key={project.id} className="card stack">
            <div className="row">
              <div>
                <h2>{project.name}</h2>
                <div className="meta">{project.localPath ?? project.repoUrl ?? 'repo not configured'}</div>
              </div>
              <Badge value={summary.state.status} />
            </div>
            <div className="grid two">
              <div className="card compact">
                <strong>Mode</strong>
                <div>{summary.state.mode}</div>
                <div className="meta">paused: {summary.state.pausedReason ?? 'none'}</div>
              </div>
              <div className="card compact">
                <strong>Budget</strong>
                <div>
                  loops {summary.state.loopsStartedToday}/{summary.state.dailyLoopBudget} · tokens{' '}
                  {summary.state.tokenUsedToday}/{summary.state.tokenBudgetDaily ?? 'not set'}
                </div>
                <div className="meta">open draft PR {summary.openDraftPrCount}/{summary.state.openDraftPrLimit}</div>
              </div>
              <div className="card compact">
                <strong>Queue</strong>
                <div>
                  proposed {summary.queue.proposed ?? 0} · approved {summary.queue.approved ?? 0} · queued{' '}
                  {summary.queue.queued ?? 0} · running {summary.queue.running ?? 0}
                </div>
                <div className="meta">processed {summary.queue.processed ?? 0} · dismissed {summary.queue.dismissed ?? 0}</div>
              </div>
              <div className="card compact">
                <strong>Current</strong>
                <div className="meta">candidate {summary.state.currentCandidateId ?? 'none'}</div>
                <div className="meta">loop {summary.state.currentLoopId ?? 'none'}</div>
                <div className="meta">next discovery {summary.state.nextDiscoveryAt ?? 'not scheduled'}</div>
              </div>
            </div>
            <form className="row" method="post" action={`/api/orchestrator/${project.id}/start`}>
              <select className="input" name="mode" defaultValue={summary.state.mode} aria-label="mode">
                <option value="supervised">supervised</option>
                <option value="auto">auto</option>
              </select>
              <input className="input" name="tokenBudgetDaily" type="number" min="1" defaultValue={summary.state.tokenBudgetDaily ?? 100000} />
              <input className="input" name="dailyLoopBudget" type="number" min="1" defaultValue={summary.state.dailyLoopBudget} />
              <button className="button" type="submit">Start</button>
              <button className="button danger" type="submit" formAction={`/api/orchestrator/${project.id}/stop`}>Stop</button>
            </form>
            <div className="stack">
              <strong>Recent events</strong>
              {summary.recentEvents.slice(-5).map((event) => (
                <div key={event.id} className="event-line">
                  #{event.seq} {event.type}
                </div>
              ))}
              {summary.recentEvents.length === 0 ? <div className="empty">orchestrator event가 없습니다.</div> : null}
            </div>
          </div>
        ))}
        {projects.length === 0 ? <div className="empty">등록된 프로젝트가 없습니다.</div> : null}
      </section>
    </>
  );
}
