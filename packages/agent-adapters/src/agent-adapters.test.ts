import http from 'node:http';
import { access, mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { extractDiff } from '@vibeloop/guards';
import { describe, expect, it } from 'vitest';
import { createTempGitRepo } from '../../../tests/helpers/repo.js';
import {
  buildCodexCommand,
  buildCodexDefaultArgs,
  buildCodexEnv,
  buildCodexProxyConfigArgs,
  CodexAgentAdapter
} from './codex.js';
import { CommandAgentAdapter } from './adapter.js';
import { MockAgentAdapter } from './mock.js';
import { resolveAgentAdapter } from './registry.js';
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

async function startMockSseUpstream(): Promise<{
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
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(
      [
        'event: response.completed',
        `data: ${JSON.stringify({
          type: 'response.completed',
          response: {
            id: 'resp_mock',
            status: 'completed',
            usage: {
              input_tokens: 5,
              output_tokens: 6,
              total_tokens: 11
            }
          }
        })}`,
        '',
        ''
      ].join('\n')
    );
    response.end();
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

describe('resolveAgentAdapter', () => {
  it('resolves command, mock, and codex specs through the shared registry', () => {
    expect(
      resolveAgentAdapter('command:node -e "process.exit(0)"', {
        loopId: 'loop-registry'
      })
    ).toBeInstanceOf(CommandAgentAdapter);
    expect(
      resolveAgentAdapter('mock:/tmp/scenario.json', {
        loopId: 'loop-registry'
      })
    ).toBeInstanceOf(MockAgentAdapter);
    expect(
      resolveAgentAdapter('codex', {
        loopId: 'loop-registry',
        proxyBaseUrl: 'http://127.0.0.1:1234'
      })
    ).toBeInstanceOf(CodexAgentAdapter);
    expect(() =>
      resolveAgentAdapter('unknown', { loopId: 'loop-registry' })
    ).toThrow('unsupported agent spec: unknown');
  });
});

describe('CodexAgentAdapter', () => {
  it('builds a command compatible with the current non-interactive Codex CLI', () => {
    expect(
      buildCodexCommand({
        worktree: '/tmp/work tree',
        taskFile: '/tmp/task file.yaml'
      })
    ).toBe("codex exec --cd '/tmp/work tree' - < '/tmp/task file.yaml'");
  });

  it('builds current Codex provider config args for the localhost proxy', () => {
    expect(buildCodexProxyConfigArgs('http://127.0.0.1:4321')).toEqual([
      '-c',
      'model_provider="vibeloop-proxy"',
      '-c',
      'model_providers.vibeloop-proxy.name="VibeLoop Proxy"',
      '-c',
      'model_providers.vibeloop-proxy.base_url="http://127.0.0.1:4321/v1"',
      '-c',
      'model_providers.vibeloop-proxy.wire_api="responses"',
      '-c',
      'model_providers.vibeloop-proxy.experimental_bearer_token="vibeloop-proxy-placeholder"'
    ]);
  });

  it('defaults Codex exec to non-interactive workspace-write mode', () => {
    expect(buildCodexDefaultArgs('http://127.0.0.1:4321').slice(0, 4)).toEqual([
      '-c',
      'sandbox_mode="workspace-write"',
      '-c',
      'approval_policy="never"'
    ]);
  });

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

  it('tracks Responses API streaming usage from Codex-compatible SSE', async () => {
    const apiKey = 'sk-test-sse-secret';
    const upstream = await startMockSseUpstream();
    const proxy = await startLlmProxy({
      upstreamBaseUrl: upstream.baseUrl,
      apiKey,
      loopId: 'loop-proxy-sse'
    });

    try {
      await fetch(`${proxy.baseUrl}/v1/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'mock', input: 'hello', stream: true })
      });

      expect(upstream.authorizations).toEqual([`Bearer ${apiKey}`]);
      expect(proxy.getUsage()).toEqual({
        prompt_tokens: 5,
        completion_tokens: 6,
        total_tokens: 11,
        requests: 1
      });
      expect(proxy.logs.join('\n')).not.toContain(apiKey);
    } finally {
      await proxy.close();
      await upstream.close();
    }
  });
});
