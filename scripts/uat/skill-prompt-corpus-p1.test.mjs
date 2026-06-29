import { describe, expect, it } from 'vitest';
import { buildP1CorpusEnv, fastVariants } from './skill-prompt-corpus-p1.mjs';

describe('P1 prompt corpus mode wrapper', () => {
  it('configures a two-variant fast lane with a fresh evidence root', () => {
    const env = buildP1CorpusEnv(
      'fast',
      {},
      { now: 1782689000000, pid: 1234 }
    );

    expect(env.VIBELOOP_SKILL_PROMPT_CORPUS_VARIANTS).toBe(fastVariants);
    expect(env.VIBELOOP_SKILL_PROMPT_CORPUS_CONCURRENCY).toBe('2');
    expect(env.VIBELOOP_UAT_EVIDENCE_DIR).toContain(
      'vibeloop-p1-fast-1234-1782689000000'
    );
    expect(env.VIBELOOP_SKILL_PROMPT_CORPUS_GITHUB_DRAFT_PR).toBeUndefined();
  });

  it('requires explicit variants for targeted reruns', () => {
    expect(() => buildP1CorpusEnv('targeted', {})).toThrow(
      'p1-targeted requires VIBELOOP_SKILL_PROMPT_CORPUS_VARIANTS'
    );

    const env = buildP1CorpusEnv('targeted', {
      VIBELOOP_SKILL_PROMPT_CORPUS_VARIANTS: 'user_issue:ko-default-cart-path'
    });
    expect(env.VIBELOOP_SKILL_PROMPT_CORPUS_VARIANTS).toBe(
      'user_issue:ko-default-cart-path'
    );
  });

  it('keeps GitHub final smoke and full lanes separate', () => {
    const smoke = buildP1CorpusEnv('github-final-smoke', {});
    expect(smoke.VIBELOOP_SKILL_PROMPT_CORPUS_VARIANTS).toBe(fastVariants);
    expect(smoke.VIBELOOP_SKILL_PROMPT_CORPUS_GITHUB_DRAFT_PR).toBe('1');

    const full = buildP1CorpusEnv('github-final-full', {
      VIBELOOP_SKILL_PROMPT_CORPUS_VARIANTS: fastVariants
    });
    expect(full.VIBELOOP_SKILL_PROMPT_CORPUS_VARIANTS).toBeUndefined();
    expect(full.VIBELOOP_SKILL_PROMPT_CORPUS_GITHUB_DRAFT_PR).toBe('1');
  });

  it('marks Gitea PR mode as a local provider without GitHub draft claims', () => {
    const env = buildP1CorpusEnv('gitea-pr', {});

    expect(env.VIBELOOP_GIT_PROVIDER).toBe('gitea');
    expect(env.VIBELOOP_GITEA_BASE_URL).toBe('http://127.0.0.1:13000');
    expect(env.VIBELOOP_GITEA_KEEP_REPO).toBe('1');
    expect(env.VIBELOOP_UAT_KEEP_TMP).toBe('1');
    expect(env.VIBELOOP_P1_SCOPE).toBe('targeted');
    expect(env.VIBELOOP_SKILL_PROMPT_CORPUS_VARIANTS).toBe(fastVariants);
    expect(env.VIBELOOP_SKILL_PROMPT_CORPUS_GITHUB_DRAFT_PR).toBeUndefined();
  });

  it('keeps Gitea PR mode targeted when parent env asks for the default corpus', () => {
    const env = buildP1CorpusEnv('gitea-pr', {
      VIBELOOP_SKILL_PROMPT_CORPUS_VARIANTS: 'default',
      VIBELOOP_SKILL_PROMPT_CORPUS_CONCURRENCY: '3'
    });

    expect(env.VIBELOOP_P1_SCOPE).toBe('targeted');
    expect(env.VIBELOOP_SKILL_PROMPT_CORPUS_VARIANTS).toBe(fastVariants);
    expect(env.VIBELOOP_SKILL_PROMPT_CORPUS_CONCURRENCY).toBe('3');
  });
});
