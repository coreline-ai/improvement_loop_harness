#!/usr/bin/env node
// Deterministic separate-process quality judge for LIVE UAT tie-breaks.
//
// This is intentionally NOT an accept gate. It only receives candidates that
// already passed the fixed verifier/evaluator and are score-tied by the core
// Arbiter. It returns a preference among that tied set so the live RU-2 lane can
// prove whether "verification pass" also had an independent quality-selection
// signal. If no candidate is measurably better by these fixed rules, it keeps the
// deterministic first candidate and says so in the rationale.
import { readFile } from 'node:fs/promises';

let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  stdin += chunk;
});

function patchScore(patch) {
  const reasons = [];
  let score = 0;

  // General anti-theater guards: passing tests by weakening assertions or
  // hard-coding the fixture should never be preferred among otherwise tied
  // candidates.
  const penalties = [
    [/test\.skip|describe\.skip|it\.skip/g, -100, 'skips tests'],
    [/expect\(true\)|assert\.ok\(true\)/g, -80, 'trivial assertion'],
    [/TODO|FIXME|HACK/g, -10, 'leaves placeholder'],
    [/items\.length\s*={2,3}\s*\d+/g, -30, 'length-based hardcode']
  ];
  for (const [pattern, value, reason] of penalties) {
    if (pattern.test(patch)) {
      score += value;
      reasons.push(reason);
    }
  }

  // Defensive correctness signals used by the standing real-user scenarios.
  const bonuses = [
    [
      /item\.quantity\s*\?\?\s*1|item\.quantity\s*\|\|\s*1/g,
      12,
      'handles missing cart quantity defensively'
    ],
    [
      /Number\(\s*item\.quantity\s*\)|Number\.isFinite|typeof\s+item\.quantity/g,
      6,
      'validates/coerces cart quantity'
    ],
    [/\.trim\(\)\.toUpperCase\(\)/g, 8, 'normalizes SKU trim+uppercase'],
    [
      /assert\.equal|assert\.deepEqual|expect\(/g,
      1,
      'adds executable assertions'
    ]
  ];
  for (const [pattern, value, reason] of bonuses) {
    const matches = patch.match(pattern);
    if (matches?.length) {
      score += value * matches.length;
      reasons.push(reason);
    }
  }

  // Prefer broader regression tests when implementation quality is otherwise
  // tied. Count added assertion lines, not the whole patch.
  const assertionLines = patch
    .split('\n')
    .filter((line) => line.startsWith('+') && /assert\.|expect\(/.test(line));
  score += Math.min(assertionLines.length, 5);
  if (assertionLines.length >= 2)
    reasons.push('multiple regression assertions');

  return { score, reasons: [...new Set(reasons)] };
}

process.stdin.on('end', async () => {
  const input = JSON.parse(stdin || '{}');
  const tied = Array.isArray(input.tied) ? input.tied : [];
  if (tied.length === 0) {
    throw new Error('quality judge requires at least one tied candidate');
  }

  const scored = [];
  for (const candidate of tied) {
    const patch = await readFile(candidate.patch_ref, 'utf8');
    scored.push({
      candidate_id: candidate.candidate_id,
      ...patchScore(patch)
    });
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.candidate_id.localeCompare(b.candidate_id);
  });

  const winner = scored[0];
  const spread = winner.score - scored[scored.length - 1].score;
  const rationale =
    spread > 0
      ? `fixed quality rules preferred ${winner.candidate_id}; spread=${spread}; reasons=${winner.reasons.join(', ') || 'none'}`
      : `no fixed quality distinction among tied candidates; kept deterministic first candidate ${winner.candidate_id}`;

  console.log(
    JSON.stringify({
      winner_candidate_id: winner.candidate_id,
      rationale
    })
  );
});
