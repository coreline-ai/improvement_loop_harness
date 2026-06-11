import { Badge } from '../../components/Badge';
import { listApprovals } from '../../lib/api';

export const dynamic = 'force-dynamic';

export default async function ApprovalsPage() {
  const approvals = await listApprovals();
  return (
    <>
      <div className="topline">Human approval queue</div>
      <h1>Approvals</h1>
      <p className="lede">위험 영역 변경은 사람이 승인하거나 거절하거나 추가 테스트를 요구해야 합니다.</p>
      <section className="section stack">
        {approvals.map((approval) => (
          <div key={approval.id} className="card stack">
            <div className="row">
              <div>
                <h2>{approval.reason}</h2>
                <div className="meta">loop: {approval.loopRunId}</div>
              </div>
              <Badge value={approval.status} />
            </div>
            <form className="stack" method="post" action={`/api/approvals/${approval.id}/approve`}>
              <textarea className="input" name="decision_reason" placeholder="decision_reason" defaultValue="Reviewed evidence and risk." />
              <div className="row">
                <button className="button" type="submit">Approve</button>
                <button className="button danger" type="submit" formAction={`/api/approvals/${approval.id}/reject`}>Reject</button>
                <button className="button warn" type="submit" formAction={`/api/approvals/${approval.id}/request-more-tests`}>Request more tests</button>
              </div>
            </form>
          </div>
        ))}
        {approvals.length === 0 ? <div className="empty">대기 중인 approval이 없습니다.</div> : null}
      </section>
    </>
  );
}
