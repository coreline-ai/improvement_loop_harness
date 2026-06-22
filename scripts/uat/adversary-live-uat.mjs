#!/usr/bin/env node
import {
  mkdir,
  mkdtemp,
  rm,
  writeFile
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  buildAdversaryLiveSafetyPlan,
  validateAdversaryLiveSafetyPlan
} from './adversary-live-safety.mjs';
import {
  buildAdversaryLivePreflightReport,
  adversaryLivePreflightExitCode
} from './adversary-live-preflight.mjs';
import {
  writeUatEvidenceBundle,
  writeUatEvidenceLedger
} from './evidence-bundle.mjs';
import {
  ADVERSARY_LIVE_SELECTED_CANDIDATE_ID,
  buildAdversaryLiveAttackScenarioResults,
  buildAdversaryLiveFilterConfig,
  buildAdversaryLiveReviewInput,
  buildCommandAdversaryReviewerProvenance,
  buildControlledAdversaryReviewerProvenance,
  buildCartSemanticProposal,
  selectAdversaryLiveReviewProposal,
  validateAdversaryReviewerProvenance,
  validateAdversaryLiveAttackScenarioResults
} from './adversary-live-contract.mjs';

const SCENARIO = 'adversary-live-uat';
const RUN_ID = `adversary-live-${process.pid}-${Date.now()}`;
const IMAGE = process.env.VIBELOOP_ADVERSARY_LIVE_IMAGE || 'node:22-alpine';
const TIMEOUT_MS = Number(
  process.env.VIBELOOP_ADVERSARY_LIVE_TIMEOUT_MS || '30000'
);
const REVIEWER_COMMAND = process.env.VIBELOOP_ADVERSARY_REVIEWER_COMMAND;
const REVIEWER_PROVIDER =
  process.env.VIBELOOP_ADVERSARY_REVIEWER_PROVIDER || undefined;
const REVIEWER_REAL_LLM =
  process.env.VIBELOOP_ADVERSARY_REVIEWER_REAL_LLM === '1';
const REVIEWER_TIMEOUT_MS = Number(
  process.env.VIBELOOP_ADVERSARY_REVIEWER_TIMEOUT_MS || '120000'
);
const BUILDER_AGENT_SPEC =
  process.env.VIBELOOP_ADVERSARY_BUILDER_AGENT_SPEC || 'mock';
const KEEP_TMP = process.env.VIBELOOP_UAT_KEEP_TMP === '1';

const safetyPlan = buildAdversaryLiveSafetyPlan({
  image: IMAGE,
  timeoutMs: TIMEOUT_MS
});
const safetyCheck = validateAdversaryLiveSafetyPlan(safetyPlan);

const {
  buildAdversaryReplayCorpus,
  buildAdversaryRulepackCandidate,
  commandAdversaryReviewer,
  confirmAdversaryM2Handoff,
  filterAdversaryReviewOutput,
  fixedAdversaryReviewContext,
  freezeAdversaryRulepack,
  inspectFrozenRulepack,
  replayAdversaryRulepack,
  resolveAdversaryReviewIndependence
} = await import('../../packages/sdk/dist/index.js');
const { filterAdversaryProposal, runGates } = await import(
  '../../packages/eval-engine/dist/index.js'
);

function exitFromPreflight(report) {
  console.log(
    JSON.stringify(
      {
        ...report,
        scenario: SCENARIO,
        run_id: RUN_ID,
        next_step:
          report.status === 'blocked'
            ? 'Resolve the reported R1 preflight failure, then rerun corepack pnpm uat:adversary-live.'
            : report.next_step
      },
      null,
      2
    )
  );
  process.exit(adversaryLivePreflightExitCode(report));
}

async function writeCartFixture(root, source) {
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src/cart.cjs'), source);
}

function semanticEvalConfig(rulepackFile) {
  return {
    schema_version: '1.0',
    project: 'adversary-live-semantic',
    execution: { isolation: 'none' },
    rulepack_semantic: {
      file: rulepackFile,
      image: IMAGE,
      network: 'none',
      timeout_ms: TIMEOUT_MS,
      current_loop_id: 'adversary-live-loop-n-plus-one'
    },
    gates: [
      {
        name: 'rulepack_semantic',
        type: 'integrity',
        command: 'builtin:rulepack-semantic',
        required: true
      }
    ]
  };
}

function semanticTask() {
  return {
    id: 'adversary-live-loop-n-plus-one',
    title: 'Adversary semantic live N+1 verification',
    objective:
      'Verify a frozen M2/M4 adversary rulepack is enforced on the next loop.',
    write_scope: { allowed: ['src/', 'tests/'] },
    required_evidence: ['m2_m4_rulepack_semantic_gate']
  };
}

async function gateContext(worktreeRoot, rulepackFile, candidateId) {
  const artifactRoot = path.join(worktreeRoot, '.vibeloop-artifacts');
  await mkdir(path.join(artifactRoot, 'input'), { recursive: true });
  const taskFile = path.join(artifactRoot, 'input/task.yaml');
  await writeFile(taskFile, `id: ${candidateId}\n`);
  return {
    evalConfig: semanticEvalConfig(rulepackFile),
    task: semanticTask(),
    taskFile,
    baseCommit: 'adversary-live-loop-n-plus-one-base',
    loopId: 'adversary-live-loop-n-plus-one',
    worktreeRoot,
    artifactRoot,
    env: { PATH: process.env.PATH ?? '' },
    changedFiles: [
      {
        path: 'src/cart.cjs',
        status: 'modified',
        isSymlink: false,
        addedLines: 1,
        deletedLines: 1
      }
    ]
  };
}

async function main() {
  if (!safetyCheck.ok) {
    throw new Error(
      `adversary live safety plan is invalid: ${JSON.stringify(safetyCheck.failures)}`
    );
  }
  const preflight = await buildAdversaryLivePreflightReport({
    safety: safetyPlan,
    timeoutMs: TIMEOUT_MS
  });
  if (preflight.status !== 'pass') {
    exitFromPreflight(preflight);
  }

  const evidenceRoot =
    process.env.VIBELOOP_UAT_EVIDENCE_DIR ||
    path.join(os.homedir(), '.vibeloop', 'uat-evidence');
  const bundle = path.join(evidenceRoot, SCENARIO, RUN_ID);
  const tmpRoot = await mkdtemp(
    path.join(os.homedir(), '.vibeloop-adversary-live-')
  );
  const workRoot = path.join(bundle, 'worktrees');
  const artifactRoot = path.join(bundle, 'artifacts');
  await mkdir(workRoot, { recursive: true });
  await mkdir(artifactRoot, { recursive: true });

  try {
    const baseWorktree = path.join(workRoot, 'loop-n-base');
    const candidateWorktree = path.join(workRoot, 'loop-n-candidate');
    const goodWorktree = path.join(workRoot, 'loop-n-plus-one-good');
    const badWorktree = path.join(workRoot, 'loop-n-plus-one-bad');
    const hardcodedWorktree = path.join(
      workRoot,
      'loop-n-plus-one-visible-only-hardcode'
    );
    const defaultQuantityHardcodedWorktree = path.join(
      workRoot,
      'loop-n-plus-one-default-quantity-hardcode'
    );
    const zeroQuantityTruthinessHardcodedWorktree = path.join(
      workRoot,
      'loop-n-plus-one-zero-quantity-truthiness-hardcode'
    );
    const buggyCart = [
      'function lineTotal(item) {',
      '  return item.price;',
      '}',
      'module.exports = { lineTotal };',
      ''
    ].join('\n');
    const fixedCart = [
      'function lineTotal(item) {',
      '  return item.price * (item.quantity ?? 1);',
      '}',
      'module.exports = { lineTotal };',
      ''
    ].join('\n');
    const hardcodedCart = [
      'function lineTotal(_item) {',
      '  return 12;',
      '}',
      'module.exports = { lineTotal };',
      ''
    ].join('\n');
    const defaultQuantityHardcodedCart = [
      'function lineTotal(item) {',
      '  return item.price * item.quantity;',
      '}',
      'module.exports = { lineTotal };',
      ''
    ].join('\n');
    const zeroQuantityTruthinessHardcodedCart = [
      'function lineTotal(item) {',
      '  return item.price * (item.quantity || 1);',
      '}',
      'module.exports = { lineTotal };',
      ''
    ].join('\n');
    await writeCartFixture(baseWorktree, buggyCart);
    await writeCartFixture(candidateWorktree, fixedCart);
    await writeCartFixture(goodWorktree, fixedCart);
    await writeCartFixture(badWorktree, buggyCart);
    await writeCartFixture(hardcodedWorktree, hardcodedCart);
    await writeCartFixture(
      defaultQuantityHardcodedWorktree,
      defaultQuantityHardcodedCart
    );
    await writeCartFixture(
      zeroQuantityTruthinessHardcodedWorktree,
      zeroQuantityTruthinessHardcodedCart
    );

    const filterConfig = buildAdversaryLiveFilterConfig();
    let proposal = buildCartSemanticProposal();
    let adversaryReview = null;
    let adversaryReviewerProvenance =
      buildControlledAdversaryReviewerProvenance();
    const handoffFile = path.join(artifactRoot, 'adversary-m2-handoff.json');
    const reviewFile = path.join(artifactRoot, 'adversary-review.json');
    const confirmationFile = path.join(artifactRoot, 'm2-confirmation.json');
    const candidateFile = path.join(artifactRoot, 'rulepack-candidate.json');
    const corpusFile = path.join(artifactRoot, 'adversary-replay-corpus.json');
    const replayFile = path.join(artifactRoot, 'm4-replay.json');
    const freezeFile = path.join(artifactRoot, 'rulepack-freeze.json');
    const rulepackFile = path.join(artifactRoot, 'rulepack.lock.json');
    const selectedPatchFile = path.join(artifactRoot, 'candidate.patch');
    const selectedPatch = buildAdversaryLiveReviewInput().selected.patch;
    await writeFile(selectedPatchFile, `${selectedPatch}\n`);

    if (REVIEWER_COMMAND) {
      const reviewInput = buildAdversaryLiveReviewInput({
        patchRef: selectedPatchFile,
        patch: selectedPatch,
        reviewerContext: fixedAdversaryReviewContext()
      });
      const reviewOutput = await commandAdversaryReviewer(REVIEWER_COMMAND, {
        timeoutMs: REVIEWER_TIMEOUT_MS,
        env: process.env
      })(reviewInput);
      adversaryReview = filterAdversaryReviewOutput({
        input: reviewInput,
        output: reviewOutput,
        filterConfig,
        independence: resolveAdversaryReviewIndependence({
          builderAgentSpec: BUILDER_AGENT_SPEC,
          reviewerProvider: REVIEWER_PROVIDER,
          requireDifferentProvider: false
        })
      });
      const reviewProposal = selectAdversaryLiveReviewProposal(adversaryReview);
      if (!reviewProposal) {
        throw new Error(
          'adversary reviewer command did not produce an accepted proposal for M2'
        );
      }
      proposal = reviewProposal;
      adversaryReviewerProvenance = buildCommandAdversaryReviewerProvenance({
        reviewReport: adversaryReview,
        realLlm: REVIEWER_REAL_LLM,
        provider: REVIEWER_PROVIDER ?? adversaryReview.reviewer_provider
      });
      const provenanceCheck = validateAdversaryReviewerProvenance(
        adversaryReviewerProvenance
      );
      if (!provenanceCheck.ok) {
        throw new Error(
          `adversary reviewer provenance is not release-grade: ${JSON.stringify(
            provenanceCheck.failures
          )}`
        );
      }
      await writeFile(
        reviewFile,
        `${JSON.stringify(
          {
            input: reviewInput,
            output: reviewOutput,
            report: adversaryReview,
            provenance: adversaryReviewerProvenance
          },
          null,
          2
        )}\n`
      );
    }

    const handoff = {
      schema_version: '1.0',
      kind: 'adversary_m2_handoff',
      authority: 'advisory_only',
      decision_impact: 'none',
      loop_id: 'adversary-live-loop-n',
      base_commit: 'fixture-base-cart-quantity',
      selected_candidate_id: ADVERSARY_LIVE_SELECTED_CANDIDATE_ID,
      selected_patch: selectedPatchFile,
      next_step: 'm2_execute_under_isolation_then_m4_replay_freeze_next_loop',
      proposals: [{ proposal, next_step: 'm2_execution_required' }]
    };
    await writeFile(handoffFile, `${JSON.stringify(handoff, null, 2)}\n`);
    const testCommand = `node ${proposal.targetPath}`;

    const confirmation = await confirmAdversaryM2Handoff({
      handoffFile,
      candidateWorktree,
      baseWorktree,
      execute: true,
      filterConfig: {
        ...filterConfig
      },
      execution: {
        image: IMAGE,
        testCommand,
        network: 'none',
        timeoutMs: TIMEOUT_MS
      },
      outputFile: confirmationFile
    });
    if (!confirmation.all_confirmed) {
      throw new Error(
        `M2 did not confirm every proposal: ${JSON.stringify(confirmation.confirmations)}`
      );
    }

    const candidate = await buildAdversaryRulepackCandidate({
      handoffFile,
      confirmationFile,
      outputFile: candidateFile
    });
    const corpus = await buildAdversaryReplayCorpus({
      handoffFile,
      candidateFile,
      testCommand,
      outputFile: corpusFile
    });
    const replay = await replayAdversaryRulepack({
      corpusFile,
      execute: true,
      worktreePath: candidateWorktree,
      image: IMAGE,
      network: 'none',
      timeoutMs: TIMEOUT_MS,
      outputFile: replayFile
    });
    if (!replay.replaySafe) {
      throw new Error(`M4 replay was not replay-safe: ${JSON.stringify(replay)}`);
    }
    const freeze = await freezeAdversaryRulepack({
      candidateFile,
      replayFile,
      outputFile: freezeFile,
      rulepackOutFile: rulepackFile
    });
    if (!freeze.frozen || !freeze.rulepack_ref) {
      throw new Error(`rulepack freeze failed: ${JSON.stringify(freeze)}`);
    }
    const inspected = await inspectFrozenRulepack(rulepackFile);
    if (!inspected.valid || !inspected.semantic_ready) {
      throw new Error(
        `frozen rulepack is not semantic ready: ${JSON.stringify(inspected)}`
      );
    }

    const good = await runGates(
      await gateContext(goodWorktree, rulepackFile, 'adversary-live-good')
    );
    const bad = await runGates(
      await gateContext(badWorktree, rulepackFile, 'adversary-live-bad')
    );
    const hardcoded = await runGates(
      await gateContext(
        hardcodedWorktree,
        rulepackFile,
        'adversary-live-visible-only-hardcode'
      )
    );
    const defaultQuantityHardcoded = await runGates(
      await gateContext(
        defaultQuantityHardcodedWorktree,
        rulepackFile,
        'adversary-live-default-quantity-hardcode'
      )
    );
    const zeroQuantityTruthinessHardcoded = await runGates(
      await gateContext(
        zeroQuantityTruthinessHardcodedWorktree,
        rulepackFile,
        'adversary-live-zero-quantity-truthiness-hardcode'
      )
    );
    const goodGate = good.report.gates.find(
      (gate) => gate.name === 'rulepack_semantic'
    );
    const badGate = bad.report.gates.find(
      (gate) => gate.name === 'rulepack_semantic'
    );
    const hardcodedGate = hardcoded.report.gates.find(
      (gate) => gate.name === 'rulepack_semantic'
    );
    const defaultQuantityHardcodedGate =
      defaultQuantityHardcoded.report.gates.find(
        (gate) => gate.name === 'rulepack_semantic'
      );
    const zeroQuantityTruthinessHardcodedGate =
      zeroQuantityTruthinessHardcoded.report.gates.find(
        (gate) => gate.name === 'rulepack_semantic'
      );
    if (
      goodGate?.status !== 'pass' ||
      badGate?.status !== 'fail' ||
      hardcodedGate?.status !== 'fail' ||
      defaultQuantityHardcodedGate?.status !== 'fail' ||
      zeroQuantityTruthinessHardcodedGate?.status !== 'fail'
    ) {
      throw new Error(
        `unexpected semantic gate results: ${JSON.stringify({
          good: goodGate,
          bad: badGate,
          hardcoded: hardcodedGate,
          defaultQuantityHardcoded: defaultQuantityHardcodedGate,
          zeroQuantityTruthinessHardcoded:
            zeroQuantityTruthinessHardcodedGate
        })}`
      );
    }
    const attackScenarioResults = buildAdversaryLiveAttackScenarioResults({
      filterAdversaryProposal,
      filterConfig,
      handoff,
      safety: safetyPlan,
      gates: {
        good: goodGate.status,
        bad: badGate.status,
        hardcoded: hardcodedGate.status,
        defaultQuantityHardcoded: defaultQuantityHardcodedGate.status,
        zeroQuantityTruthinessHardcoded:
          zeroQuantityTruthinessHardcodedGate.status
      }
    });
    const attackScenarioCheck =
      validateAdversaryLiveAttackScenarioResults(attackScenarioResults);
    if (!attackScenarioCheck.ok) {
      throw new Error(
        `adversary live attack scenarios did not pass: ${JSON.stringify(
          attackScenarioCheck.failures
        )}`
      );
    }

    const ledger = {
      status: 'ADVERSARY_LIVE_PASS',
      scenario: SCENARIO,
      run_id: RUN_ID,
      mode: REVIEWER_COMMAND
        ? 'advisory reviewer command + real R1 M2/M4 execution'
        : 'controlled command adversary + real R1 M2/M4 execution',
      adversary_reviewer: adversaryReviewerProvenance,
      image: IMAGE,
      evidence_bundle: bundle,
      artifacts: {
        selected_patch: selectedPatchFile,
        ...(adversaryReview ? { adversary_review: reviewFile } : {}),
        handoff: handoffFile,
        confirmation: confirmationFile,
        candidate: candidateFile,
        replay_corpus: corpusFile,
        replay: replayFile,
        freeze: freezeFile,
        rulepack: rulepackFile
      },
      m2: {
        executed: confirmation.executed,
        runtime_available: confirmation.runtime_available,
        confirmed_count: confirmation.confirmed_count,
        all_confirmed: confirmation.all_confirmed
      },
      safety: safetyPlan,
      safety_check: safetyCheck,
      candidate: {
        candidate_created: candidate.candidate_created,
        added_rule_count: candidate.added_rules.length
      },
      corpus: {
        case_count: corpus.case_count
      },
      m4: {
        executed: replay.executed,
        replay_safe: replay.replaySafe,
        total: replay.total,
        matched: replay.matched
      },
      freeze: {
        frozen: freeze.frozen,
        rulepack_ref: freeze.rulepack_ref
      },
      inspect: {
        valid: inspected.valid,
        semantic_ready: inspected.semantic_ready,
        status: inspected.status
      },
      n_plus_one: {
        good_gate_status: goodGate.status,
        bad_gate_status: badGate.status,
        hardcoded_gate_status: hardcodedGate.status,
        default_quantity_hardcoded_gate_status:
          defaultQuantityHardcodedGate.status,
        zero_quantity_truthiness_hardcoded_gate_status:
          zeroQuantityTruthinessHardcodedGate.status,
        bad_rejected: badGate.status === 'fail',
        visible_only_hardcode_rejected: hardcodedGate.status === 'fail',
        default_quantity_hardcode_rejected:
          defaultQuantityHardcodedGate.status === 'fail',
        zero_quantity_truthiness_hardcode_rejected:
          zeroQuantityTruthinessHardcodedGate.status === 'fail'
      },
      attack_scenarios: {
        checked_count: attackScenarioResults.length,
        passed_count: attackScenarioResults.filter((result) => result.passed)
          .length,
        check: attackScenarioCheck,
        results: attackScenarioResults
      },
      ...(adversaryReview ? { adversary_review: adversaryReview } : {}),
      limitation: REVIEWER_COMMAND
        ? 'This UAT used an advisory reviewer command proposal; it remains current-loop advisory only and still requires R1 M2/M4 evidence.'
        : 'This UAT uses a controlled command adversary proposal; real Codex adversary reviewer generation remains a separate live lane.'
    };
    const evidenceBundle = await writeUatEvidenceBundle({
      scenario: SCENARIO,
      runId: RUN_ID,
      tmpRoot,
      dataDir: artifactRoot,
      output: ledger,
      extraFiles: [
        { kind: 'report', label: 'm2-handoff', path: handoffFile },
        ...(adversaryReview
          ? [{ kind: 'report', label: 'adversary-review', path: reviewFile }]
          : []),
        { kind: 'report', label: 'candidate-patch', path: selectedPatchFile },
        { kind: 'report', label: 'm2-confirmation', path: confirmationFile },
        { kind: 'report', label: 'rulepack-candidate', path: candidateFile },
        { kind: 'report', label: 'm4-replay-corpus', path: corpusFile },
        { kind: 'report', label: 'm4-replay', path: replayFile },
        { kind: 'report', label: 'rulepack-freeze', path: freezeFile },
        { kind: 'report', label: 'rulepack-lock', path: rulepackFile }
      ],
      extraJson: {
        safety: safetyPlan,
        safety_check: safetyCheck,
        adversary_reviewer: ledger.adversary_reviewer,
        ...(adversaryReview ? { adversary_review: adversaryReview } : {}),
        attack_scenarios: ledger.attack_scenarios
      },
      evidenceDir: evidenceRoot
    });
    ledger.evidence_bundle = evidenceBundle.bundle_dir;
    ledger.evidence_manifest = evidenceBundle.manifest_path;
    ledger.evidence_copied_count = evidenceBundle.copied_count + 1;
    ledger.evidence_missing_count = evidenceBundle.missing_count;
    const ledgerFile = await writeUatEvidenceLedger(evidenceBundle, ledger);
    console.log(JSON.stringify({ ...ledger, ledger: ledgerFile }, null, 2));
  } finally {
    if (!KEEP_TMP) {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exit(1);
});
