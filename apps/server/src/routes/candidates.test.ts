import { describe, expect, it } from 'vitest';
import { MemoryStore } from '../memory-store.js';
import type { Store } from '../types.js';
import { createCandidateIfNew } from './candidates.js';

function staleFirstFingerprintLookupStore(store: MemoryStore): Store {
  let findCalls = 0;
  return new Proxy(store, {
    get(target, property, receiver) {
      if (property === 'findCandidateByFingerprint') {
        return async (
          ...args: Parameters<Store['findCandidateByFingerprint']>
        ) => {
          findCalls += 1;
          if (findCalls === 1) return null;
          return target.findCandidateByFingerprint(...args);
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  }) as Store;
}

describe('candidate route helpers', () => {
  it('returns the raced-in candidate when fingerprint creation collides', async () => {
    const store = new MemoryStore();
    const project = await store.createProject({ name: 'race-project' });
    const existing = await store.createCandidate({
      projectId: project.id,
      source: 'manual',
      fingerprint: 'same-fingerprint',
      title: 'Existing candidate',
      status: 'proposed'
    });

    const result = await createCandidateIfNew(
      staleFirstFingerprintLookupStore(store),
      {
        projectId: project.id,
        source: 'manual',
        fingerprint: 'same-fingerprint',
        title: 'Duplicate candidate',
        evidenceRefs: [],
        priority: 1,
        status: 'proposed',
        location: {
          filePath: 'src/index.ts',
          errorCode: 'manual'
        }
      }
    );

    expect(result.id).toBe(existing.id);
    await expect(store.listCandidates(project.id)).resolves.toHaveLength(1);
  });
});
