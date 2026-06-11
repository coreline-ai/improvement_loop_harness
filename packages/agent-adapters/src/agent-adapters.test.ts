import http from 'node:http';
import { access, mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { extractDiff } from '@vibeloop/guards';
import { describe, expect, it } from 'vitest';
import { createTempGitRepo } from '../../../tests/helpers/repo.js';
import { buildCodexEnv, CodexAgentAdapter } from './codex.js';
import { MockAgentAdapter } from './mock.js';
import { startLlmProxy } from './proxy/server.js';

async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function startMockUpstream(apiKey: string): Promise<{
  baseUrl: string;
  close(): Promise<void>;
  authorizations: string[];
}> {
  const authorizations: string[] = [];
  const server = http.createServer(async (request, response) => {
    authorizations.push(request.headers.authorization ?? '');
    for await (const chunk of request) {
      void chunk;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        id: 'chatcmpl_mock',
        usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
        key_echo: apiKey
      })
    );
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('upstream failed to bind');
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    authorizations,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      })
  };
}

describe('MockAgentAdapter', () => {
  it('applies modify/create/commit scenario and leaves all changes visible from the original base', async () => {
    const repo = await createTempGitRepo();
    const adapter = new MockAgentAdapter({
      actions: [
        {
          type: 'modify',
          path: 'README.md',
          content: '# fixture repo\n\nmodified\n'
        },
        {
          type: 'create',
          path: 'src/new.ts',
          content: 'export const created = true;\n'
        },
        { type: 'commit', message: 'mock changes' }
      ]
    });

    const result = await adapter.run({
      worktree: repo.repoPath,
      taskFile: path.join(repo.repoPath, 'task.yaml')
    });
    const diff = await extractDiff({
      repoPath: repo.repoPath,
      baseCommit: repo.initialCommit
    });

    expect(result.status).toBe('pass');
    expect(diff.changedFiles.map((file) => [file.path, file.status])).toEqual([
      ['README.md', 'modified'],
      ['src/new.ts', 'added']
    ]);
  });
});

describe('CodexAgentAdapter', () => {
  it('scrubs real provider keys and exposes only the localhost proxy base URL', () => {
    const env = buildCodexEnv({
      sourceEnv: {
        PATH: '/bin',
        OPENAI_API_KEY: 'real-openai-key',
        ANTHROPIC_API_KEY: 'real-anthropic-key',
        GITHUB_TOKEN: 'real-github-token'
      },
      proxyBaseUrl: 'http://127.0.0.1:12345',
      loopId: 'loop-1',
      taskFile: '/tmp/task.yaml',
      homeDir: '/tmp/vibeloop-home'
    });

    expect(env.OPENAI_BASE_URL).toBe('http://127.0.0.1:12345');
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(JSON.stringify(env)).not.toContain('real-openai-key');
  });

  it('returns error on timeout and kills the underlying process group', async () => {
    const artifactDir = await tempDir('vibeloop-codex-timeout-');
    const marker = path.join(artifactDir, 'late.txt');
    const script = `setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},'late'),1200); setInterval(()=>{},1000);`;
    const adapter = new CodexAgentAdapter({
      binary: 'node',
      appendDefaultArgs: false,
      args: ['-e', script],
      proxyBaseUrl: 'http://127.0.0.1:1',
      loopId: 'loop-timeout'
    });

    const result = await adapter.run({
      worktree: artifactDir,
      taskFile: path.join(artifactDir, 'task.yaml'),
      env: { PATH: process.env.PATH ?? '' },
      timeoutMs: 200
    });
    await new Promise((resolve) => setTimeout(resolve, 1300));

    expect(result.status).toBe('error');
    expect(result.timedOut).toBe(true);
    await expect(fileExists(marker)).resolves.toBe(false);
  });
});

describe('LLM proxy', () => {
  it('attaches the upstream key, tracks loop usage, and redacts proxy logs', async () => {
    const apiKey = 'sk-test-secret';
    const upstream = await startMockUpstream(apiKey);
    const proxy = await startLlmProxy({
      upstreamBaseUrl: upstream.baseUrl,
      apiKey,
      loopId: 'loop-proxy'
    });

    try {
      const response = await fetch(`${proxy.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'mock',
          messages: [{ role: 'user', content: 'hello' }]
        })
      });
      await response.json();

      expect(upstream.authorizations).toEqual([`Bearer ${apiKey}`]);
      expect(proxy.getUsage()).toMatchObject({
        prompt_tokens: 3,
        completion_tokens: 4,
        total_tokens: 7,
        requests: 1
      });
      expect(proxy.logs.join('\n')).not.toContain(apiKey);
    } finally {
      await proxy.close();
      await upstream.close();
    }
  });
});
