import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Badge } from '../../../components/Badge';
import { LoopEvents } from '../../../components/LoopEvents';
import { ApiError, getLoop, latestEvalReport, listReports } from '../../../lib/api';

export const dynamic = 'force-dynamic';

export default async function LoopDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const loop = await getLoop(id);
    const report = latestEvalReport(await listReports(id))?.reportJson;
    const gates = report?.gate_runs ?? [];
    return (
      <>
        <div className="topline">Loop</div>
        <h1>{loop.id}</h1>
        <p className="lede">gate 실행, 로그 ref, 상태 이벤트를 loop seq 기준으로 확인합니다.</p>
        <section className="section card grid three">
          <div><div className="meta">status</div><Badge value={loop.status} /></div>
          <div><div className="meta">decision</div><Badge value={loop.decision ?? report?.decision ?? loop.status} /></div>
          <div><div className="meta">report</div><Link className="link" href={`/loops/${loop.id}/report`}>open report →</Link></div>
        </section>
        <section className="section card">
          <h2>Gate status</h2>
          <table className="table">
            <thead><tr><th>Name</th><th>Type</th><th>Required</th><th>Status</th><th>Logs</th></tr></thead>
            <tbody>
              {gates.map((gate) => (
                <tr key={gate.name}>
                  <td>{gate.name}</td>
                  <td>{gate.type}</td>
                  <td>{gate.required ? 'yes' : 'no'}</td>
                  <td><Badge value={gate.status} /></td>
                  <td className="meta">
                    {gate.stdout_ref ? <span>stdout: {gate.stdout_ref}</span> : null}
                    {gate.stdout_ref && gate.stderr_ref ? <br /> : null}
                    {gate.stderr_ref ? <span>stderr: {gate.stderr_ref}</span> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {gates.length === 0 ? <div className="empty">gate report가 아직 없습니다.</div> : null}
        </section>
        <section className="section">
          <LoopEvents loopId={loop.id} />
        </section>
      </>
    );
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) notFound();
    throw error;
  }
}
