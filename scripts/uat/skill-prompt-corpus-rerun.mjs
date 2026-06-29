function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

export function failedVariantKeys(results) {
  const keys = [];
  const seen = new Set();
  for (const result of results ?? []) {
    if (result?.pass === true) continue;
    const mode = result?.mode;
    const variant = result?.variant_id;
    if (!mode || !variant) continue;
    const key = `${mode}:${variant}`;
    if (seen.has(key)) continue;
    seen.add(key);
    keys.push(key);
  }
  return keys;
}

export function buildFailedVariantRerunPlan(results, options = {}) {
  const variants = failedVariantKeys(results);
  if (variants.length === 0) return null;

  const env = [
    `VIBELOOP_SKILL_PROMPT_CORPUS_VARIANTS=${shellQuote(variants.join(','))}`
  ];
  let command = 'corepack pnpm uat:skill-loop:p1-targeted';
  let lane = 'p1-targeted';

  if (options.gitProvider === 'gitea') {
    command = 'corepack pnpm uat:skill-loop:p1-gitea-pr';
    lane = 'p1-gitea-pr';
    if (options.giteaBaseUrl) {
      env.push(`VIBELOOP_GITEA_BASE_URL=${shellQuote(options.giteaBaseUrl)}`);
    }
  } else if (options.githubDraftPrRequested === true) {
    command = 'corepack pnpm uat:skill-loop:prompt-corpus-live';
    lane = 'prompt-corpus-live:github-pr-targeted';
    env.push('VIBELOOP_SKILL_PROMPT_CORPUS_GITHUB_DRAFT_PR=1');
    if (options.keepRemote === true) {
      env.push('VIBELOOP_UAT_KEEP_REMOTE=1');
    }
  }

  return {
    lane,
    variant_count: variants.length,
    variants,
    command: `${env.join(' ')} ${command}`
  };
}
