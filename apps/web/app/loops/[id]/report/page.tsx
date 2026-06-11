import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Badge } from '../../../../components/Badge';
import { allPass, ApiError, artifactHref, getLoop, latestEvalReport, listReports } from '../../../../lib/api';

export const dynamic = 'force-dynamic';

export default async function LoopReportPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const loop = await getLoop(id);
    const reportRecord = latestEvalReport(await listReports(id));
    const report = reportRecord?.reportJson;
    const reasons = report?.decision_reasons ?? [];
    const evidence = report?.improvement_evidence ?? [];
    const artifactRefs = report?.artifact_refs ?? [];
    const changed = report?.changed_files ?? [];

    return (
      <>
        <div className="topline">Eval report</div>
        <h1>{loop.id}</h1>
        <p className="lede">decision reason, improvement evidence, changed files를 PR 전 검토 단위로 모아 보여줍니다.</p>
        <section className="section card stack">
          <div className="row">
            <div>
              <div className="meta">decision</div>
              <Badge value={report?.decision ?? loop.decision ?? loop.status} />
            </div>
            {allPass(report) ? <div className="pass-banner" data-testid="all-pass">ALL_PASS</div> : null}
          </div>
          {report?.summary ? <p>{report.summary}</p> : null}
          <Link className="link" href={`/loops/${loop.id}`}>← loop detail</Link>
        </section>
        <section className="section grid two">
          <div className="card stack">
            <h2>Decision reasons</h2>
            {reasons.map((reason) => (
              <div className="card compact" key={`${reason.code}-${reason.message}`}>
                <strong>{reason.code}</strong>
                <p className="meta">{reason.message}</p>
              </div>
            ))}
            {reasons.length === 0 ? <div className="empty">decision reason이 없습니다.</div> : null}
          </div>
          <div className="card stack">
            <h2>Evidence</h2>
            {evidence.map((entry) => (
              <div className="card compact stack" key={entry.type}>
                <div className="row">
                  <span>{entry.type}</span>
                  <Badge value={entry.status} />
                </div>
                {entry.supporting_gate ? <div className="meta">supporting gate: {entry.supporting_gate}</div> : null}
                {entry.artifact_ref ? (
                  <Link className="link" href={artifactHref(loop.id, entry.artifact_ref)}>
                    artifact: {entry.artifact_ref}
                  </Link>
                ) : null}
              </div>
            ))}
            {evidence.length === 0 ? <div className="empty">evidence가 없습니다.</div> : null}
            {artifactRefs.length > 0 ? (
              <div className="stack">
                <h3>Artifact refs</h3>
                {artifactRefs.map((artifactRef) => (
                  <Link className="link" key={artifactRef} href={artifactHref(loop.id, artifactRef)}>
                    {artifactRef}
                  </Link>
                ))}
              </div>
            ) : null}
          </div>
        </section>
        <section className="section card">
          <h2>Changed files</h2>
          <table className="table">
            <thead><tr><th>Path</th><th>Status</th><th>Lines</th></tr></thead>
            <tbody>
              {changed.map((file) => (
                <tr key={file.path}>
                  <td className="code">{file.path}</td>
                  <td><Badge value={file.status} /></td>
                  <td className="meta">+{file.added_lines ?? 0} / -{file.deleted_lines ?? 0}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {changed.length === 0 ? <div className="empty">변경 파일 정보가 없습니다.</div> : null}
        </section>
      </>
    );
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) notFound();
    throw error;
  }
}
