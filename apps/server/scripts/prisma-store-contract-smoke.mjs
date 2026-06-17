#!/usr/bin/env node
const databaseUrl = process.env.TEST_DATABASE_URL;

if (!databaseUrl) {
  console.error('TEST_DATABASE_URL is required');
  process.exit(2);
}

let storeModule;
try {
  storeModule = await import('../dist/prisma-store.js');
} catch (error) {
  console.error(
    `failed to load built PrismaStore; run corepack pnpm --filter @vibeloop/server build first: ${error instanceof Error ? error.message : String(error)}`
  );
  process.exit(3);
}

const { createPrismaClient, PrismaStore } = storeModule;
const prisma = createPrismaClient(databaseUrl);
const store = new PrismaStore(prisma);
const suffix = `${process.pid}-${Date.now()}`;
const fingerprint = `postgres-contract-smoke-${suffix}`;

try {
  const project = await store.createProject({
    name: `postgres contract smoke ${suffix}`,
    localPath: `/tmp/postgres-contract-smoke-${suffix}`
  });
  const candidate = await store.createCandidate({
    projectId: project.id,
    source: 'manual',
    fingerprint,
    title: 'Postgres contract smoke candidate',
    trustLevel: 'low',
    injectionIndicators: ['instruction_override'],
    reproCommand: 'corepack pnpm test -- --runInBand',
    evidenceRefs: ['smoke:evidence'],
    status: 'proposed'
  });
  const persisted = await store.findCandidateByFingerprint(
    project.id,
    fingerprint
  );
  if (!persisted) {
    throw new Error('candidate was not persisted');
  }
  if (persisted.id !== candidate.id) {
    throw new Error('candidate id did not round-trip');
  }
  if (persisted.trustLevel !== 'low') {
    throw new Error('trustLevel did not round-trip');
  }
  if (!Array.isArray(persisted.injectionIndicators)) {
    throw new Error('injectionIndicators did not round-trip as an array');
  }
  if (!persisted.injectionIndicators.includes('instruction_override')) {
    throw new Error('injectionIndicators lost instruction_override');
  }
  if (persisted.reproCommand !== 'corepack pnpm test -- --runInBand') {
    throw new Error('reproCommand did not round-trip');
  }

  let duplicateRejected = false;
  try {
    await store.createCandidate({
      projectId: project.id,
      source: 'manual',
      fingerprint,
      title: 'Duplicate smoke candidate'
    });
  } catch (error) {
    duplicateRejected = String(error?.message ?? error).includes(
      'candidate fingerprint already exists'
    );
  }
  if (!duplicateRejected) {
    throw new Error('duplicate candidate fingerprint was not rejected');
  }

  console.log(
    JSON.stringify({
      ok: true,
      project_id: project.id,
      candidate_id: candidate.id,
      checks: {
        candidate_roundtrip: 'pass',
        security_metadata_roundtrip: 'pass',
        duplicate_fingerprint_rejected: 'pass'
      }
    })
  );
} finally {
  await prisma.$disconnect().catch(() => undefined);
}
