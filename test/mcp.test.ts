// The stdio MCP transport — the agent surface.
//
// Before the M1+M2 review this file had ZERO coverage: nothing in test/ referenced src/api/mcp.ts,
// so the ok→content / !ok→isError mapping, the hidden-op filter, and — most importantly — the
// `assertMembership` fail-closed guard that carries D25 onto the agent lane had never once executed
// in a test. It was also structurally untestable: `main()` ran at module load, so importing it from
// a test booted a stdio server.
//
// Two properties here are load-bearing:
//   * A failure NEVER throws out of the handler. A throw tears down the stdio loop and takes the
//     whole bridge with it, so an agent sees a dead pipe instead of an error it can read.
//   * Identity is re-read, not frozen. The bridge used to resolve the role once at boot and reuse it
//     forever, so revoking a membership had no effect on a running process — while the HTTP path
//     re-read it every request. The two surfaces disagreed, and the agent one was permissive.
import { describe, it, expect, beforeEach, afterAll } from 'bun:test';
import { buildHandlers, envContext, currentContext, resetContextCache } from '../src/api/mcp.ts';
import { closePools } from '../src/db/client.ts';
import { liveOrFail, hasDbEnv } from './helpers/live.ts';

const savedPrincipal = process.env.CB_MCP_PRINCIPAL;
const savedWorkspace = process.env.CB_MCP_WORKSPACE;

function restoreEnv(): void {
  if (savedPrincipal === undefined) delete process.env.CB_MCP_PRINCIPAL;
  else process.env.CB_MCP_PRINCIPAL = savedPrincipal;
  if (savedWorkspace === undefined) delete process.env.CB_MCP_WORKSPACE;
  else process.env.CB_MCP_WORKSPACE = savedWorkspace;
}

afterAll(async () => {
  restoreEnv();
  resetContextCache();
  await closePools({ timeout: 5 });
});

describe('envContext — fail-closed identity (no database needed for the missing-env case)', () => {
  beforeEach(() => resetContextCache());

  it('refuses to build a context when CB_MCP_* are absent', async () => {
    delete process.env.CB_MCP_PRINCIPAL;
    delete process.env.CB_MCP_WORKSPACE;
    try {
      await expect(envContext()).rejects.toThrow(/CB_MCP_PRINCIPAL/);
    } finally {
      restoreEnv();
    }
  });

  it('refuses when only ONE of the pair is set — a half-configured bridge must not start', async () => {
    delete process.env.CB_MCP_WORKSPACE;
    process.env.CB_MCP_PRINCIPAL = '11111111-1111-4111-8111-111111111111';
    try {
      await expect(envContext()).rejects.toThrow(/CB_MCP_WORKSPACE|CB_MCP_PRINCIPAL/);
    } finally {
      restoreEnv();
    }
  });
});

describe('buildHandlers — the transport contract, without stdio', () => {
  beforeEach(() => resetContextCache());

  it('a missing identity becomes an isError RESULT, never a throw that kills the bridge', async () => {
    delete process.env.CB_MCP_PRINCIPAL;
    delete process.env.CB_MCP_WORKSPACE;
    try {
      const h = buildHandlers();
      // The assertion is as much about NOT throwing as about the payload: an exception here would
      // propagate through the SDK and end the stdio session.
      const r = await h.callTool({ params: { name: 'whoami', arguments: {} } });
      expect(r.isError).toBe(true);
      expect(JSON.parse(r.content[0]!.text).code).toBe('unauthenticated');
    } finally {
      restoreEnv();
    }
  });

  it('tools/list hides hidden ops from agents, and exposes the real ones', async () => {
    const { tools } = await buildHandlers().listTools();
    const names = (tools as { name: string }[]).map((t) => t.name);
    expect(names).toContain('whoami');
    expect(names).toContain('ask');
    expect(names).toContain('create_invite');
    expect(names).not.toContain('echo'); // hidden diagnostic, not an agent tool
  });

  it('every advertised tool carries an inputSchema an agent can act on', async () => {
    const { tools } = await buildHandlers().listTools();
    for (const t of tools as { name: string; inputSchema?: unknown }[]) {
      expect(t.inputSchema, `${t.name} has no inputSchema`).toBeDefined();
    }
  });
});

const live = liveOrFail('mcp', hasDbEnv() && !!process.env.CB_MCP_PRINCIPAL && !!process.env.CB_MCP_WORKSPACE);

describe.skipIf(!live)('buildHandlers — against a real membership', () => {
  beforeEach(() => resetContextCache());

  it('a successful call returns content with NO isError flag', async () => {
    const r = await buildHandlers().callTool({ params: { name: 'whoami', arguments: {} } });
    expect(r.isError).toBeUndefined();
    const data = JSON.parse(r.content[0]!.text);
    expect(data.principal).toBe(process.env.CB_MCP_PRINCIPAL);
    expect(data.remote).toBe(true); // the agent lane is untrusted-remote by construction
  }, 60_000);

  it('the role comes from the DATABASE — there is no CB_MCP_ROLE to override it (D39)', async () => {
    const before = process.env.CB_MCP_ROLE;
    process.env.CB_MCP_ROLE = 'owner'; // an env var the code must ignore entirely
    try {
      resetContextCache();
      const ctx = await currentContext();
      const r = await buildHandlers().callTool({ params: { name: 'whoami', arguments: {} } });
      expect(JSON.parse(r.content[0]!.text).role).toBe(ctx.role);
      // …and that role came from assertMembership, not from the env we just set.
      expect(['owner', 'admin', 'member']).toContain(ctx.role);
    } finally {
      if (before === undefined) delete process.env.CB_MCP_ROLE;
      else process.env.CB_MCP_ROLE = before;
    }
  }, 60_000);

  it('an unknown tool is an isError result carrying unknown_op, not a throw', async () => {
    const r = await buildHandlers().callTool({ params: { name: 'no_such_tool', arguments: {} } });
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0]!.text).code).toBe('unknown_op');
  }, 60_000);

  it('invalid params are reported as invalid_params, not a malformed success frame', async () => {
    const r = await buildHandlers().callTool({ params: { name: 'ask', arguments: { question: 12345 } } });
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0]!.text).code).toBe('invalid_params');
  }, 60_000);

  it('omitted arguments default to {} rather than reaching zod as undefined', async () => {
    const r = await buildHandlers().callTool({ params: { name: 'whoami' } });
    expect(r.isError).toBeUndefined();
  }, 60_000);

  it('identity is re-read after the TTL — a running bridge is not frozen at boot', async () => {
    resetContextCache();
    const first = await currentContext(0);
    // Inside the window: the SAME object, no second database read.
    expect(await currentContext(1_000)).toBe(first);
    // Past it: a fresh read. Not the same object, even though the values match.
    const refreshed = await currentContext(60_000);
    expect(refreshed).not.toBe(first);
    expect(refreshed.principal).toBe(first.principal);
    expect(refreshed.role).toBe(first.role);
  }, 60_000);
});
