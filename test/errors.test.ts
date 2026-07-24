import { describe, it, expect } from 'bun:test';
import { OperationError, statusFor, mapContextError, type OpErrorCode } from '../src/api/errors.ts';
import { ContextError, type ContextErrorCode } from '../src/core/context.ts';

describe('statusFor — exhaustive code→status', () => {
  const cases: [OpErrorCode, number][] = [
    ['unauthenticated', 401],
    ['no_workspace', 400],
    ['no_grant', 403],
    ['bad_principal', 400],
    ['bad_workspace', 400],
    ['bad_grant', 400],
    ['unknown_op', 404],
    ['invalid_params', 400],
    ['insufficient_role', 403],
    ['permission_denied', 403],
    ['not_found', 404],
    ['internal_error', 500],
  ];
  for (const [code, status] of cases) {
    it(`${code} → ${status}`, () => expect(statusFor(code)).toBe(status));
  }
  it('an unknown code defaults to 500, never 200', () => {
    expect(statusFor('totally_bogus' as OpErrorCode)).toBe(500);
  });
});

describe('OperationError', () => {
  it('exposes status from its code and serializes to a code-keyed wire error', () => {
    const e = new OperationError('not_found', 'nope', 'try X', 'https://docs');
    expect(e.status).toBe(404);
    expect(e.toWire()).toEqual({ code: 'not_found', message: 'nope', suggestion: 'try X', docs: 'https://docs' });
  });
});

describe('mapContextError — folds all 6 ContextError codes into the wire taxonomy', () => {
  const codes: ContextErrorCode[] = [
    'unauthenticated',
    'no_workspace',
    'no_grant',
    'bad_principal',
    'bad_workspace',
    'bad_grant',
  ];
  for (const code of codes) {
    it(`${code} preserves code + maps to a status`, () => {
      const oe = mapContextError(new ContextError(code, `msg for ${code}`));
      expect(oe.code).toBe(code);
      expect(oe.status).toBe(statusFor(code));
      expect(oe.status).toBeGreaterThanOrEqual(400);
    });
  }
});
