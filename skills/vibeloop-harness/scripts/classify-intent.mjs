#!/usr/bin/env node
// Natural-language intent router for the vibeloop-harness Skill.
//
// This is a deterministic helper for the Skill/LLM layer, not an accept gate.
// It classifies the user's request into the safest VibeLoop mode so the LLM can
// route to the correct CLI path without inventing a workflow. The harness still
// owns all accept/quality decisions.

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2).replaceAll('-', '_');
    const value = argv[i + 1];
    if (!value || value.startsWith('--')) {
      out[key] = true;
    } else {
      out[key] = value;
      i += 1;
    }
  }
  return out;
}

function normalize(text) {
  return String(text ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function matchAny(text, patterns) {
  const codes = [];
  for (const [code, pattern] of patterns) {
    if (pattern.test(text)) codes.push(code);
  }
  return codes;
}

const patterns = {
  adversarialUat: [
    ['adversarial', /\badversar(?:y|ial)\b|적대적|깨보기|공격/i],
    ['failure_cases', /실패\s*케이스|failure\s*case|negative\s*uat|false\s*pass/i],
    ['leak_or_tamper', /hidden\s*leak|context\s*leak|누설|tamper|변조/i]
  ],
  codexLiveUat: [
    ['codex_live', /codex[-\s]*live|real\s*codex|실\s*codex|실제\s*llm/i],
    ['github_pr', /github|draft\s*pr|실\s*repo|실제\s*repo/i],
    ['real_user', /real\s*user|실사용자|실\s*사용자/i]
  ],
  fixtureFullUat: [
    ['full_uat', /full\s*uat|풀\s*uat|full\s*test|풀\s*테스트/i],
    ['fixture_baseline', /fixture|baseline|고정\s*검증|카탈로그/i]
  ],
  selfImprovementUat: [
    ['self_improvement', /self[-\s]*improvement|자가\s*개선|자기\s*개선/i],
    ['challenger_selection', /challenger|도전자|더\s*나은\s*후보|최고\s*수정/i]
  ],
  verifyOnly: [
    ['verify_only', /verify[-\s]*only|검증만|검증\s*해|테스트만|patch\s*검증|패치\s*검증/i],
    ['existing_patch', /existing\s*patch|기존\s*패치|수정된\s*내용/i]
  ],
  autoDiscovery: [
    ['auto_discovery', /자동\s*문제\s*발견|문제\s*찾|자율\s*개선|autonomous|discover/i],
    ['scan_repo', /repo\s*scan|프로젝트\s*스캔|전체\s*스캔|분석해서\s*수정/i],
    ['sequential_issue', /하나씩|1개씩|순차|issue\s*queue|다중\s*이슈/i]
  ],
  userIssue: [
    ['fix_request', /고쳐|수정|fix|repair|버그|bug|개선/i],
    ['specific_path', /(?:src|lib|app|packages|tests)\/[\w./-]+|\b[\w.-]+\.(?:js|ts|tsx|py|rb|go|rs|java|cjs|mjs)\b/i],
    ['specific_symptom', /quantity|sku|login|auth|timeout|에러|오류|실패|깨짐/i]
  ],
  report: [
    ['report', /report|eval-report|리포트|보고서|요약|summar/i]
  ]
};

const modeSpecs = {
  adversarial_uat: {
    command_hint: 'pnpm uat:skill-loop:adversarial',
    task_eval_required: false,
    single_issue_policy: false,
    limitations: [
      'fixture/adversarial UAT lane only unless a live adversary lane is explicitly configured'
    ]
  },
  codex_live_uat: {
    command_hint: 'pnpm uat:skill-loop:codex-live or pnpm uat:skill-loop:codex-live:multi',
    task_eval_required: true,
    single_issue_policy: true,
    limitations: [
      'requires codex login, GitHub auth for PR evidence, and a real test repository'
    ]
  },
  fixture_full_uat: {
    command_hint: 'pnpm uat:skill-loop:full',
    task_eval_required: false,
    single_issue_policy: false,
    limitations: ['FULL_UAT_PASS is fixture baseline only, not live Codex/GitHub proof']
  },
  self_improvement_uat: {
    command_hint: 'pnpm uat:skill-loop:self-improvement',
    task_eval_required: false,
    single_issue_policy: false,
    limitations: ['hermetic proof lane unless VIBELOOP_UAT_GITHUB=1 is set']
  },
  verify_only: {
    command_hint: 'vibeloop run --eval-only-patch <patch> or retry eval-only path',
    task_eval_required: true,
    single_issue_policy: true,
    limitations: ['does not ask a builder agent to edit again']
  },
  auto_discovery: {
    command_hint: 'vibeloop orchestrate --repo <repo> --eval <eval.yaml> ...; use --generate-eval only for minimal visible-test eval',
    task_eval_required: false,
    single_issue_policy: true,
    limitations: [
      'current orchestrate is core substrate, not RU-3 full loop until cumulative apply + rediscovery + PR branch are enabled'
    ]
  },
  user_issue: {
    command_hint: 'create task/eval, then vibeloop improve --repo <repo> --task <task.yaml> --eval <eval.yaml> ...',
    task_eval_required: true,
    single_issue_policy: true,
    limitations: ['create exactly one task/eval pair for the specified issue']
  },
  report: {
    command_hint: 'node skills/vibeloop-harness/scripts/summarize-report.mjs --report <eval-report.json>',
    task_eval_required: false,
    single_issue_policy: false,
    limitations: ['summarize only from deterministic reports']
  },
  unknown: {
    command_hint: 'ask for repo path, one issue or auto-discovery mode, and acceptance command',
    task_eval_required: true,
    single_issue_policy: true,
    limitations: ['do not run a builder until intent and acceptance command are known']
  }
};

function classify(prompt) {
  const text = normalize(prompt);
  if (text.length === 0) {
    return { mode: 'unknown', confidence: 0, reason_codes: [] };
  }

  const matches = Object.fromEntries(
    Object.entries(patterns).map(([key, value]) => [key, matchAny(text, value)])
  );

  // UAT/report/verify requests are explicit operational modes and should win over
  // generic words like "fix" or "test".
  if (matches.adversarialUat.length >= 1 && /uat|테스트|case|케이스|검증/i.test(text)) {
    return {
      mode: 'adversarial_uat',
      confidence: 0.9,
      reason_codes: matches.adversarialUat
    };
  }
  if (matches.codexLiveUat.length >= 2 && /uat|테스트|검증|run|실행/i.test(text)) {
    return {
      mode: 'codex_live_uat',
      confidence: 0.88,
      reason_codes: matches.codexLiveUat
    };
  }
  if (matches.selfImprovementUat.length >= 1 && /uat|테스트|검증|loop|루프/i.test(text)) {
    return {
      mode: 'self_improvement_uat',
      confidence: 0.86,
      reason_codes: matches.selfImprovementUat
    };
  }
  if (matches.fixtureFullUat.length >= 1 && /uat|테스트|검증|baseline|fixture/i.test(text)) {
    return {
      mode: 'fixture_full_uat',
      confidence: 0.82,
      reason_codes: matches.fixtureFullUat
    };
  }
  if (matches.verifyOnly.length >= 1) {
    return {
      mode: 'verify_only',
      confidence: 0.84,
      reason_codes: matches.verifyOnly
    };
  }
  if (matches.report.length >= 1 && !matches.userIssue.includes('fix_request')) {
    return { mode: 'report', confidence: 0.8, reason_codes: matches.report };
  }
  if (matches.autoDiscovery.length >= 1) {
    return {
      mode: 'auto_discovery',
      confidence: matches.autoDiscovery.length >= 2 ? 0.88 : 0.78,
      reason_codes: matches.autoDiscovery
    };
  }
  if (
    matches.userIssue.includes('fix_request') &&
    (matches.userIssue.includes('specific_path') ||
      matches.userIssue.includes('specific_symptom'))
  ) {
    return {
      mode: 'user_issue',
      confidence: 0.82,
      reason_codes: matches.userIssue
    };
  }
  if (matches.userIssue.includes('fix_request')) {
    return {
      mode: 'user_issue',
      confidence: 0.62,
      reason_codes: matches.userIssue
    };
  }

  return { mode: 'unknown', confidence: 0.25, reason_codes: [] };
}

const args = parseArgs(process.argv.slice(2));
const prompt = args.prompt ?? process.env.VIBELOOP_SKILL_PROMPT ?? '';
const result = classify(prompt);
const spec = modeSpecs[result.mode] ?? modeSpecs.unknown;

console.log(
  JSON.stringify(
    {
      schema_version: '1.0',
      prompt_present: String(prompt).trim().length > 0,
      ...result,
      ...spec,
      accept_authority: 'deterministic_harness_only',
      full_improvement_pass_rule:
        'strict_score_improvement_every_issue=false => never call FULL autonomous improvement PASS'
    },
    null,
    2
  )
);
