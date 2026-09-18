import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { ragtestAdapter, resolveAdapter } from '../src/eval/adapters/index.ts';

const FIXTURE_DIR = join(import.meta.dir, 'fixtures', 'ragtest');

describe('RAGTest adapter', () => {
  it('is registered and preserves quoted commas/newlines while mapping document indexes to gold ids', async () => {
    expect(resolveAdapter('ragtest')).toBe(ragtestAdapter);
    const bundle = await ragtestAdapter.load(FIXTURE_DIR);
    expect(bundle.docs).toEqual([
      expect.objectContaining({
        id: 'ragtest-doc-0',
        title: 'Bullet Kin',
        body: 'Bullet Kin, common enemy.\nIt fires one bullet.',
      }),
      expect.objectContaining({ id: 'ragtest-doc-1', title: 'Giant' }),
    ]);
    expect(bundle.questions).toEqual([
      expect.objectContaining({ id: 'ragtest-single_passage-0000', goldDocIds: ['ragtest-doc-0'], type: 'single_passage' }),
      expect.objectContaining({ id: 'ragtest-multi_passage-0000', goldDocIds: ['ragtest-doc-1'], type: 'multi_passage' }),
      expect.objectContaining({ id: 'ragtest-no-answer-0000', goldDocIds: [], type: 'no_answer' }),
    ]);
  });
});
