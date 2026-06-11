import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { RunManifest } from '@vibeloop/artifacts';
import type { EvalReport, GateReport } from '@vibeloop/eval-engine';
import { htmlDocument } from './template.js';

export interface RenderReportHtmlOptions {
  evalReport: EvalReport;
  gateReport?: GateReport | undefined;
  manifest?: RunManifest | undefined;
  generatedAt?: Date | undefined;
}

export interface WriteReportHtmlOptions extends RenderReportHtmlOptions {
  runRoot: string;
  outputFile?: string | undefined;
}

export interface WrittenReportHtml {
  html: string;
  path: string;
  fileUrl: string;
}

const EXTERNAL_REQUEST_PATTERN = /\b(?:src|href)=["']https?:\/\//i;

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function normalizeRef(ref: string): string {
  return ref.split(path.sep).join('/').replace(/^\.\//, '');
}

function artifactHref(artifactRef: string): string {
  const normalized = normalizeRef(artifactRef);
  const relative = path.posix.relative('reports', normalized);
  return relative.length === 0 ? '.' : relative;
}

function badge(value: string): string {
  return `<span class="badge ${escapeHtml(value)}">${escapeHtml(value)}</span>`;
}

function artifactLink(ref: string | null | undefined): string {
  if (!ref) {
    return '<span class="small">—</span>';
  }
  const href = artifactHref(ref);
  return `<a href="${escapeHtml(href)}">${escapeHtml(ref)}</a>`;
}

function summaryCards(options: RenderReportHtmlOptions): string {
  const report = options.evalReport;
  const manifest = options.manifest;
  const cards = [
    ['Decision', badge(report.decision)],
    ['Loop', escapeHtml(report.loop_id)],
    ['Task', escapeHtml(report.task_id)],
    ['Project', escapeHtml(report.project_id ?? manifest?.project_id ?? '—')],
    ['Base commit', escapeHtml(report.base_commit)],
    ['Status', escapeHtml(manifest?.status ?? '—')]
  ];
  return `<section class="summary">${cards
    .map(
      ([label, value]) =>
        `<div class="card"><div class="label">${label}</div><div class="value">${value}</div></div>`
    )
    .join('')}</section>`;
}

function reasonsTable(report: EvalReport): string {
  return `<table><thead><tr><th>Code</th><th>Message</th><th>Ref</th></tr></thead><tbody>${report.decision_reasons
    .map(
      (reason) =>
        `<tr><td><code>${escapeHtml(reason.code)}</code></td><td>${escapeHtml(reason.message)}</td><td>${artifactLink(reason.ref)}</td></tr>`
    )
    .join('')}</tbody></table>`;
}

function gatesTable(report: EvalReport): string {
  return `<table><thead><tr><th>Name</th><th>Type</th><th>Required</th><th>Status</th><th>Duration</th><th>Logs</th><th>Summary</th></tr></thead><tbody>${report.gate_runs
    .map(
      (gate) =>
        `<tr><td>${escapeHtml(gate.name)}</td><td>${escapeHtml(gate.type)}</td><td>${gate.required ? 'yes' : 'no'}</td><td>${badge(gate.status)}</td><td>${escapeHtml(gate.duration_ms ?? '—')}</td><td>${artifactLink(gate.stdout_ref)} ${artifactLink(gate.stderr_ref)}</td><td>${escapeHtml(gate.summary ?? '')}</td></tr>`
    )
    .join('')}</tbody></table>`;
}

function evidenceTable(report: EvalReport): string {
  return `<table><thead><tr><th>Type</th><th>Status</th><th>Supporting gate</th><th>Artifact</th></tr></thead><tbody>${report.improvement_evidence
    .map(
      (evidence) =>
        `<tr><td>${escapeHtml(evidence.type)}</td><td>${badge(evidence.status)}</td><td>${escapeHtml(evidence.supporting_gate ?? '—')}</td><td>${artifactLink(evidence.artifact_ref)}</td></tr>`
    )
    .join('')}</tbody></table>`;
}

function changedFilesTable(report: EvalReport): string {
  return `<table><thead><tr><th>Path</th><th>Status</th><th>Allowed</th><th>Protected</th></tr></thead><tbody>${report.changed_files
    .map(
      (file) =>
        `<tr><td><code>${escapeHtml(file.path)}</code></td><td>${escapeHtml(file.status)}</td><td>${file.allowed_by_write_scope ? 'yes' : 'no'}</td><td>${file.protected ? 'yes' : 'no'}</td></tr>`
    )
    .join('')}</tbody></table>`;
}

function artifactRefs(report: EvalReport): string {
  return `<ul>${report.artifact_refs
    .map((ref) => `<li>${artifactLink(ref)}</li>`)
    .join('')}</ul>`;
}

function gateReportNote(gateReport: GateReport | undefined): string {
  if (!gateReport) {
    return '<p class="small">gate-report.json was not found.</p>';
  }
  return `<p class="small">Gate report generated at ${escapeHtml(gateReport.generated_at)} with ${gateReport.gates.length} gate entries.</p>`;
}

export function renderReportHtml(options: RenderReportHtmlOptions): string {
  const report = options.evalReport;
  const body = `<main>
<h1>VibeLoop Eval Report</h1>
<p class="small">Generated ${escapeHtml((options.generatedAt ?? new Date()).toISOString())}</p>
${summaryCards(options)}
<h2>Summary</h2>
<pre>${escapeHtml(report.summary ?? '')}</pre>
<h2>Decision Reasons</h2>
${reasonsTable(report)}
<h2>Gate Runs</h2>
${gateReportNote(options.gateReport)}
${gatesTable(report)}
<h2>Improvement Evidence</h2>
${evidenceTable(report)}
<h2>Changed Files</h2>
${changedFilesTable(report)}
<h2>Artifact Links</h2>
${artifactRefs(report)}
</main>`;
  return htmlDocument({
    title: `VibeLoop ${report.loop_id} ${report.decision}`,
    body
  });
}

export function hasExternalRequests(html: string): boolean {
  return EXTERNAL_REQUEST_PATTERN.test(html);
}

export function assertNoExternalRequests(html: string): void {
  if (hasExternalRequests(html)) {
    throw new Error('HTML report contains external src/href requests');
  }
}

export async function writeReportHtml(
  options: WriteReportHtmlOptions
): Promise<WrittenReportHtml> {
  const outputFile =
    options.outputFile ?? path.join(options.runRoot, 'reports', 'report.html');
  const html = renderReportHtml(options);
  assertNoExternalRequests(html);
  await mkdir(path.dirname(outputFile), { recursive: true });
  await writeFile(outputFile, html);
  return { html, path: outputFile, fileUrl: pathToFileURL(outputFile).href };
}

export async function readReportInputs(runRoot: string): Promise<{
  evalReport: EvalReport;
  gateReport?: GateReport | undefined;
  manifest?: RunManifest | undefined;
}> {
  const evalReport = JSON.parse(
    await readFile(path.join(runRoot, 'reports', 'eval-report.json'), 'utf8')
  ) as EvalReport;
  const gateReportRaw = await readFile(
    path.join(runRoot, 'reports', 'gate-report.json'),
    'utf8'
  ).catch(() => undefined);
  const manifestRaw = await readFile(
    path.join(runRoot, 'manifest.json'),
    'utf8'
  ).catch(() => undefined);
  return {
    evalReport,
    ...(gateReportRaw
      ? { gateReport: JSON.parse(gateReportRaw) as GateReport }
      : {}),
    ...(manifestRaw ? { manifest: JSON.parse(manifestRaw) as RunManifest } : {})
  };
}

export async function writeReportHtmlFromRunRoot(
  runRoot: string
): Promise<WrittenReportHtml> {
  const inputs = await readReportInputs(runRoot);
  return writeReportHtml({ runRoot, ...inputs });
}
