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
    const trust = report?.trust_summary;
    const verifier = report?.verifier;
    const advisory = report?.advisory_findings ?? [];

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
        <section className="section card stack" data-testid="trust-boundary">
          <h2>Trust boundary</h2>
          <div className="grid three">
            <div><div className="meta">deterministic</div><Badge value={trust?.deterministic_authority ?? 'decision_engine'} /></div>
            <div><div className="meta">provenance</div><Badge value={trust?.provenance_verified === false ? 'mismatch' : 'verified'} /></div>
            <div><div className="meta">hidden</div><Badge value={trust?.hidden_acceptance_status ?? 'not_configured'} /></div>
          </div>
          <div className="grid three">
            <div><div className="meta">verifier</div><Badge value={trust?.verifier_status ?? 'not_configured'} /></div>
            <div><div className="meta">advisory findings</div><Badge value={String(trust?.advisory_findings_count ?? advisory.length)} /></div>
            <div><div className="meta">human review reason</div><Badge value={trust?.human_review_reason_code ?? 'none'} /></div>
          </div>
          <p className="meta">LLM/advisory 결과는 최종 authority가 아니며, accept는 deterministic decision engine의 고정 기준으로만 산출됩니다.</p>
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
        <section className="section grid two">
          <div className="card stack">
            <h2>Verifier lanes</h2>
            {(verifier?.lanes ?? []).map((lane) => (
              <div className="card compact" key={lane.lane}>
                <strong>{lane.lane}</strong> <Badge value={lane.status} />
                <div className="meta">decision: {lane.decision ?? 'unknown'}</div>
              </div>
            ))}
            {(verifier?.lanes ?? []).length === 0 ? <div className="empty">verifier lane 정보가 없습니다.</div> : null}
          </div>
          <div className="card stack">
            <h2>Advisory findings</h2>
            {advisory.map((finding, index) => (
              <div className="card compact" key={index}>
                <strong>{String(finding.gate ?? finding.source ?? `finding-${index}`)}</strong>
                <div className="meta">authority: {String(finding.authority ?? 'advisory')}</div>
                {'same_model_review' in finding ? <div className="meta">same model: {String(finding.same_model_review)}</div> : null}
              </div>
            ))}
            {advisory.length === 0 ? <div className="empty">advisory finding이 없습니다.</div> : null}
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
