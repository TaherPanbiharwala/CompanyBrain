// Op-level error envelope. Ported from gbrain's OperationError (src/core/operations.ts) under MIT —
// see NOTICE. Adapted for company-brain: the wire key is `code` (gbrain uses `error`); adds an
// exhaustive code→status map and mapContextError, folding M0's ContextError (src/core/context.ts)
// into one closed wire error taxonomy (review AM3 / DECISIONS D10/A16).
import type { ContextError, ContextErrorCode } from '../core/context.ts';

// The single closed set of error codes a caller can see on the wire.
export type OpErrorCode =
  | 'unauthenticated' // 401 — no/invalid identity
  | 'no_workspace' // 400 — no workspace resolved for the request
  | 'no_grant' // 403 — empty grants keyring
  | 'bad_principal' // 400 — principal is not a valid uuid
  | 'bad_workspace' // 400 — workspaceId is not a valid uuid
  | 'bad_grant' // 400 — a grant tag is malformed
  | 'unknown_op' // 404 — no operation with that name
  | 'invalid_params' // 400 — params failed schema validation
  | 'payload_too_large' // 413 — request body exceeded the json limit
  | 'insufficient_role' // 403 — caller role too low for this op
  | 'permission_denied' // 403 — reserved for acl && grants row denial (M3)
  | 'not_found' // 404 — handler-level resource miss
  | 'internal_error'; // 500 — unexpected failure

export interface WireError {
  code: OpErrorCode;
  message: string;
  suggestion?: string;
  docs?: string;
}

/** Exhaustive code→HTTP status. The `never` assignment makes an unhandled new code a COMPILE error;
 *  the trailing 500 is the runtime backstop for a code smuggled in via a cast (never 200). */
export function statusFor(code: OpErrorCode): number {
  switch (code) {
    case 'unauthenticated':
      return 401;
    case 'no_workspace':
    case 'bad_principal':
    case 'bad_workspace':
    case 'bad_grant':
    case 'invalid_params':
      return 400;
    case 'payload_too_large':
      return 413;
    case 'no_grant':
    case 'insufficient_role':
    case 'permission_denied':
      return 403;
    case 'unknown_op':
    case 'not_found':
      return 404;
    case 'internal_error':
      return 500;
    default: {
      const _exhaustive: never = code;
      void _exhaustive;
      return 500;
    }
  }
}

export class OperationError extends Error {
  readonly code: OpErrorCode;
  readonly suggestion?: string;
  readonly docs?: string;
  constructor(code: OpErrorCode, message: string, suggestion?: string, docs?: string) {
    super(message);
    this.name = 'OperationError';
    this.code = code;
    this.suggestion = suggestion;
    this.docs = docs;
  }
  get status(): number {
    return statusFor(this.code);
  }
  toWire(): WireError {
    return { code: this.code, message: this.message, suggestion: this.suggestion, docs: this.docs };
  }
}

// ContextErrorCode is a subset of OpErrorCode (identical names), so the mapping is identity + a
// helpful suggestion. mapContextError is reused unchanged by M2's real session resolver.
export function mapContextError(e: ContextError): OperationError {
  return new OperationError(e.code as OpErrorCode, e.message, contextSuggestion(e.code));
}

function contextSuggestion(code: ContextErrorCode): string | undefined {
  switch (code) {
    case 'unauthenticated':
      return 'Attach a valid session/identity before calling operations.';
    case 'no_workspace':
      return 'Select a workspace (by uuid) for this request.';
    case 'no_grant':
      return 'Your keyring is empty; contact a workspace admin if this persists.';
    case 'bad_principal':
    case 'bad_workspace':
      return 'Provide a valid uuid.';
    case 'bad_grant':
      return 'A grant tag is malformed.';
    default: {
      const _exhaustive: never = code;
      void _exhaustive;
      return undefined;
    }
  }
}
