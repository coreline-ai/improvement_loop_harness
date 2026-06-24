import { createHash } from 'node:crypto';
import {
  cp,
  mkdir,
  readFile,
  readdir,
  stat,
  writeFile
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const SAFE_SEGMENT_PATTERN = /[^A-Za-z0-9._-]+/g;
const REPORT_PATH_KEYS = [
  'report',
  'report_path',
  'quality_report_ref',
  'selection_report',
  'selected_report',
  'reverify_report'
];
const RUN_ROOT_KEYS = ['artifact_root', 'selected_artifact_root'];

export function shouldPruneUatTmp(env = process.env) {
  return env.VIBELOOP_UAT_PRUNE === '1' && env.VIBELOOP_UAT_KEEP_TMP !== '1';
}

export function defaultUatEvidenceDir(env = process.env) {
  return path.resolve(
    env.VIBELOOP_UAT_EVIDENCE_DIR ||
      path.join(os.homedir(), '.vibeloop', 'uat-evidence')
  );
}

export function uatEvidencePolicy(env = process.env) {
  return {
    tmp_preserved_by_default: true,
    tmp_prune_requires: 'VIBELOOP_UAT_PRUNE=1',
    legacy_keep_tmp_override: env.VIBELOOP_UAT_KEEP_TMP === '1',
    prune_requested: env.VIBELOOP_UAT_PRUNE === '1',
    will_prune_tmp: shouldPruneUatTmp(env)
  };
}

function safeSegment(value, fallback) {
  const raw = String(value ?? fallback)
    .replace(SAFE_SEGMENT_PATTERN, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
  if (!raw || raw === '.' || raw === '..' || raw.includes('..')) {
    return fallback;
  }
  return raw;
}

async function existsAsFile(filePath) {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}

async function existsAsDirectory(filePath) {
  try {
    return (await stat(filePath)).isDirectory();
  } catch {
    return false;
  }
}

async function sha256(filePath) {
  return createHash('sha256')
    .update(await readFile(filePath))
    .digest('hex');
}

function shortHash(value) {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 12);
}

function relativeRef(root, filePath) {
  return path.relative(root, filePath).split(path.sep).join('/');
}

async function walkFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) return walkFiles(absolutePath);
      if (entry.isFile()) return [absolutePath];
      return [];
    })
  );
  return nested.flat().sort();
}

async function recordFile(bundleDir, kind, label, sourcePath, targetPath) {
  const fileStat = await stat(targetPath);
  return {
    kind,
    label,
    source_path: sourcePath,
    bundle_path: relativeRef(bundleDir, targetPath),
    sha256: await sha256(targetPath),
    size_bytes: fileStat.size
  };
}

async function copyEvidenceFile({
  bundleDir,
  kind,
  label,
  sourcePath,
  relativeTarget,
  copied,
  missing
}) {
  if (!sourcePath || !(await existsAsFile(sourcePath))) {
    missing.push({
      kind,
      label,
      source_path: sourcePath ?? null,
      reason: 'missing'
    });
    return;
  }

  const targetPath = path.join(bundleDir, relativeTarget);
  await mkdir(path.dirname(targetPath), { recursive: true });
  await cp(sourcePath, targetPath, { force: true });
  copied.push(await recordFile(bundleDir, kind, label, sourcePath, targetPath));
}

function addStringPath(paths, value) {
  if (typeof value === 'string' && value.trim().length > 0) {
    paths.add(value);
  }
}

function visitOutputForPaths(value, reportPaths, runRoots) {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const entry of value)
      visitOutputForPaths(entry, reportPaths, runRoots);
    return;
  }

  for (const key of REPORT_PATH_KEYS) addStringPath(reportPaths, value[key]);
  for (const key of RUN_ROOT_KEYS) addStringPath(runRoots, value[key]);
  if (value.final_verification) {
    visitOutputForPaths(value.final_verification, reportPaths, runRoots);
  }
  if (Array.isArray(value.discovery_reports)) {
    for (const reportPath of value.discovery_reports) {
      addStringPath(reportPaths, reportPath);
    }
  }
  if (Array.isArray(value.issues)) {
    for (const issue of value.issues)
      visitOutputForPaths(issue, reportPaths, runRoots);
  }
  if (Array.isArray(value.cases)) {
    for (const testCase of value.cases) {
      visitOutputForPaths(testCase, reportPaths, runRoots);
    }
  }
  if (Array.isArray(value.candidates)) {
    for (const candidate of value.candidates) {
      visitOutputForPaths(candidate, reportPaths, runRoots);
    }
  }
  if (Array.isArray(value.iterations)) {
    for (const iteration of value.iterations) {
      visitOutputForPaths(iteration, reportPaths, runRoots);
    }
  }
}

function collectReportAndRunRootPaths(outputs = []) {
  const reportPaths = new Set();
  const runRoots = new Set();
  for (const output of outputs) {
    visitOutputForPaths(output, reportPaths, runRoots);
  }
  return { reportPaths, runRoots };
}

async function maybeAddQualityReport(reportPath, reportPaths) {
  if (!reportPath || path.basename(reportPath) === 'quality-report.json')
    return;
  const qualityPath = path.join(
    path.dirname(reportPath),
    'quality-report.json'
  );
  if (await existsAsFile(qualityPath)) {
    reportPaths.add(qualityPath);
  }
}

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  );
}

async function findRunRootForPath(filePath, dataDir) {
  if (!filePath || !dataDir) return null;
  const resolvedDataDir = path.resolve(dataDir);
  let cursor = path.dirname(path.resolve(filePath));
  while (isInside(resolvedDataDir, cursor) && cursor !== resolvedDataDir) {
    if (await existsAsFile(path.join(cursor, 'manifest.json'))) return cursor;
    cursor = path.dirname(cursor);
  }
  return null;
}

async function markCopiedManifestAuditKeep(runRootCopy, reason) {
  const manifestPath = path.join(runRootCopy, 'manifest.json');
  if (!(await existsAsFile(manifestPath))) return;

  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  await writeFile(
    manifestPath,
    `${JSON.stringify(
      {
        ...manifest,
        audit_keep: true,
        audit_keep_reason: reason
      },
      null,
      2
    )}\n`
  );
}

function reserveRunRootTarget({
  bundleDir,
  relativeRunRoot,
  runRoot,
  usedRunRootTargets
}) {
  let relativeTarget = relativeRunRoot;
  let targetRef = relativeRef(
    bundleDir,
    path.join(bundleDir, 'runs', relativeTarget)
  );
  if (!usedRunRootTargets.has(targetRef)) {
    usedRunRootTargets.add(targetRef);
    return relativeTarget;
  }

  const base = safeSegment(path.basename(runRoot), 'run-root');
  const hash = shortHash(path.resolve(runRoot));
  let index = 0;
  do {
    const suffix = index === 0 ? `${base}-${hash}` : `${base}-${hash}-${index}`;
    relativeTarget = path.join('__duplicates__', suffix);
    targetRef = relativeRef(bundleDir, path.join(bundleDir, 'runs', relativeTarget));
    index += 1;
  } while (usedRunRootTargets.has(targetRef));

  usedRunRootTargets.add(targetRef);
  return relativeTarget;
}

async function copyRunRoot({
  bundleDir,
  runRoot,
  dataDir,
  copied,
  missing,
  usedRunRootTargets
}) {
  if (!(await existsAsDirectory(runRoot))) {
    missing.push({
      kind: 'run_root',
      label: safeSegment(path.basename(runRoot), 'run-root'),
      source_path: runRoot,
      reason: 'missing'
    });
    return;
  }

  const resolvedDataDir = dataDir
    ? path.resolve(dataDir)
    : path.dirname(runRoot);
  const relativeRunRoot = isInside(resolvedDataDir, path.resolve(runRoot))
    ? relativeRef(resolvedDataDir, path.resolve(runRoot))
    : safeSegment(path.basename(runRoot), 'run-root');
  const targetRoot = path.join(
    bundleDir,
    'runs',
    reserveRunRootTarget({
      bundleDir,
      relativeRunRoot,
      runRoot,
      usedRunRootTargets
    })
  );
  await mkdir(path.dirname(targetRoot), { recursive: true });
  await cp(runRoot, targetRoot, { recursive: true, force: true });
  await markCopiedManifestAuditKeep(
    targetRoot,
    'preserved by live UAT evidence bundle'
  );

  for (const filePath of await walkFiles(targetRoot)) {
    copied.push(
      await recordFile(
        bundleDir,
        'run_root',
        relativeRef(targetRoot, filePath),
        path.join(runRoot, relativeRef(targetRoot, filePath)),
        filePath
      )
    );
  }
}

function sanitizeProxyStats(stats) {
  if (!stats || typeof stats !== 'object') return null;
  return {
    mode: stats.mode ?? null,
    requests: stats.requests ?? null,
    response_requests: stats.response_requests ?? null,
    model_requests: stats.model_requests ?? null,
    auth_header_seen: stats.auth_header_seen ?? null,
    auth_header_missing: stats.auth_header_missing ?? null,
    upstream_statuses: Array.isArray(stats.upstream_statuses)
      ? stats.upstream_statuses
      : [],
    usage: stats.usage ?? null
  };
}

async function writeJsonEvidence({
  bundleDir,
  kind,
  label,
  relativeTarget,
  value,
  copied
}) {
  const targetPath = path.join(bundleDir, relativeTarget);
  await mkdir(path.dirname(targetPath), { recursive: true });
  await writeFile(targetPath, `${JSON.stringify(value, null, 2)}\n`);
  copied.push(
    await recordFile(bundleDir, kind, label, '[generated]', targetPath)
  );
  return targetPath;
}

export async function writeUatEvidenceBundle({
  scenario,
  runId,
  tmpRoot,
  dataDir,
  outputs = [],
  output = null,
  proxyStats = null,
  extraFiles = [],
  extraJson = {},
  evidenceDir = defaultUatEvidenceDir()
}) {
  const scenarioSegment = safeSegment(scenario, 'uat-scenario');
  const runSegment = safeSegment(runId, `run-${Date.now()}`);
  const bundleDir = path.join(
    path.resolve(evidenceDir),
    scenarioSegment,
    runSegment
  );
  await mkdir(bundleDir, { recursive: true });

  const copied = [];
  const missing = [];
  const outputList = output ? [...outputs, output] : outputs;
  const { reportPaths, runRoots } = collectReportAndRunRootPaths(outputList);

  for (const reportPath of [...reportPaths]) {
    await maybeAddQualityReport(reportPath, reportPaths);
  }
  for (const reportPath of reportPaths) {
    const runRoot = await findRunRootForPath(reportPath, dataDir);
    if (runRoot) runRoots.add(runRoot);
  }

  let reportIndex = 0;
  for (const reportPath of [...reportPaths].sort()) {
    reportIndex += 1;
    await copyEvidenceFile({
      bundleDir,
      kind: 'report',
      label: path.basename(reportPath),
      sourcePath: reportPath,
      relativeTarget: path.join(
        'reports',
        `${String(reportIndex).padStart(2, '0')}-${safeSegment(
          path.basename(reportPath),
          'report.json'
        )}`
      ),
      copied,
      missing
    });
  }

  for (const extraFile of extraFiles) {
    const label = safeSegment(extraFile.label, 'extra');
    const sourcePath = extraFile.path;
    await copyEvidenceFile({
      bundleDir,
      kind: extraFile.kind ?? 'log',
      label,
      sourcePath,
      relativeTarget: path.join(
        extraFile.kind === 'report' ? 'reports' : 'logs',
        `${label}-${safeSegment(path.basename(sourcePath ?? ''), 'artifact')}`
      ),
      copied,
      missing
    });
  }

  const usedRunRootTargets = new Set();
  for (const runRoot of [...runRoots].sort()) {
    await copyRunRoot({
      bundleDir,
      runRoot,
      dataDir,
      copied,
      missing,
      usedRunRootTargets
    });
  }

  const proxyStatsPath = proxyStats
    ? await writeJsonEvidence({
        bundleDir,
        kind: 'proxy_stats',
        label: 'proxy-stats',
        relativeTarget: path.join('proxy', 'proxy-stats.json'),
        value: sanitizeProxyStats(proxyStats),
        copied
      })
    : null;

  for (const [label, value] of Object.entries(extraJson)) {
    await writeJsonEvidence({
      bundleDir,
      kind: 'metadata',
      label: safeSegment(label, 'metadata'),
      relativeTarget: path.join(
        'metadata',
        `${safeSegment(label, 'metadata')}.json`
      ),
      value,
      copied
    });
  }

  const manifest = {
    schema_version: '1.0',
    scenario,
    run_id: runId,
    created_at: new Date().toISOString(),
    bundle_dir: bundleDir,
    tmp_root: tmpRoot,
    data_dir: dataDir,
    policy: uatEvidencePolicy(),
    proxy_stats_ref: proxyStatsPath
      ? relativeRef(bundleDir, proxyStatsPath)
      : null,
    copied,
    missing
  };
  const manifestPath = path.join(bundleDir, 'uat-evidence-manifest.json');
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  return {
    bundle_dir: bundleDir,
    manifest_path: manifestPath,
    copied_count: copied.length,
    missing_count: missing.length,
    report_count: [...reportPaths].length,
    run_root_count: [...runRoots].length
  };
}

export async function writeUatEvidenceLedger(bundle, ledger) {
  const ledgerPath = path.join(bundle.bundle_dir, 'ledger.json');
  await writeFile(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);

  const manifest = JSON.parse(await readFile(bundle.manifest_path, 'utf8'));
  const ledgerRecord = await recordFile(
    bundle.bundle_dir,
    'ledger',
    'ledger',
    '[generated]',
    ledgerPath
  );
  await writeFile(
    bundle.manifest_path,
    `${JSON.stringify(
      {
        ...manifest,
        ledger_ref: relativeRef(bundle.bundle_dir, ledgerPath),
        copied: [
          ...manifest.copied.filter((entry) => entry.kind !== 'ledger'),
          ledgerRecord
        ]
      },
      null,
      2
    )}\n`
  );
  return ledgerPath;
}
