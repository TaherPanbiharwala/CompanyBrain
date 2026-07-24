import { describe, it, expect } from 'bun:test';
import { parseModelId, chat, RouterError, withRouterScope } from '../src/ai/router.ts';
import { config } from '../src/config.ts';

describe('parseModelId', () => {
  it('defaults provider to openrouter when there is no colon', () => {
    expect(parseModelId('qwen/qwen-2.5')).toEqual({ provider: 'openrouter', model: 'qwen/qwen-2.5' });
  });
  it('colon wins over slash (OpenRouter org/model ids survive)', () => {
    expect(parseModelId('openrouter:org/model')).toEqual({ provider: 'openrouter', model: 'org/model' });
  });
  it('handles an empty string without throwing', () => {
    expect(parseModelId('')).toEqual({ provider: 'openrouter', model: '' });
  });
});

describe('router scope binding (fail closed)', () => {
  it('chat() throws when called outside withRouterScope', async () => {
    await expect(chat({ messages: [{ role: 'user', content: 'hi' }], model: 'openrouter:org/model' }))
      .rejects.toThrow(RouterError);
  });
});

// D12.1: chat model is intentionally unset — chat() must throw rather than default to a provider.
// Skips if someone has actually configured CHAT_MODEL (bun test auto-loads .env).
describe.skipIf(!!config.CHAT_MODEL)('chat model intentionally unset (DECISIONS D12.1)', () => {
  it('throws RouterError instead of defaulting to Anthropic/OpenAI', async () => {
    await expect(
      withRouterScope({ workspaceId: crypto.randomUUID(), zdr: false }, () =>
        chat({ messages: [{ role: 'user', content: 'hi' }] })),
    ).rejects.toThrow(RouterError);
  });
});
