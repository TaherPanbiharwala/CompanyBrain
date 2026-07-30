// Shape-only param redaction + the request log. Ported from gbrain's summarizeMcpParams / bucketBytes
// (src/mcp/dispatch.ts) under MIT — see NOTICE. The sacred M1 invariant: the request log records
// param SHAPES, never param VALUES, and never an error message (review AM1).
import type { Operation } from './operations.ts';

export interface ParamSummary {
  kind: 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null';
  declared_keys?: string[]; // submitted keys the op declares (names are the public schema — safe)
  unknown_key_count?: number; // submitted keys NOT declared (count only — names never emitted)
  length?: number; // array length
  approx_bytes?: number; // JSON size bucketed to 1KB (kills a content-length side-channel)
}

/** Round up to the nearest 1KB so a payload-length side-channel can't leak secret content size. */
export function bucketBytes(n: number): number {
  return Math.ceil(n / 1024) * 1024;
}

function approxBytes(v: unknown): number | undefined {
  try {
    return bucketBytes(JSON.stringify(v)?.length ?? 0);
  } catch {
    return undefined;
  }
}

/** Summarize SUBMITTED params without emitting any value. Uses rawParams (not the parsed output):
 *  z.object strips unknown keys, so counting them requires the raw input, and the invalid-params
 *  branch has no parsed output to summarize. */
export function summarizeParams(op: Operation | undefined, rawParams: unknown): ParamSummary | null {
  if (rawParams === null) return { kind: 'null' };
  if (rawParams === undefined) return null;
  if (Array.isArray(rawParams)) {
    return { kind: 'array', length: rawParams.length, approx_bytes: approxBytes(rawParams) };
  }
  if (typeof rawParams === 'object') {
    const submitted = Object.keys(rawParams as Record<string, unknown>);
    const declared = op ? new Set(Object.keys(op.params.shape)) : new Set<string>();
    const declared_keys = submitted.filter((k) => declared.has(k)).sort();
    return {
      kind: 'object',
      declared_keys,
      unknown_key_count: submitted.length - declared_keys.length,
      approx_bytes: approxBytes(rawParams),
    };
  }
  const t = typeof rawParams; // string | number | boolean (bigint/symbol/function don't come from JSON)
  const kind = (t === 'string' || t === 'number' || t === 'boolean' ? t : 'string') as ParamSummary['kind'];
  return { kind, approx_bytes: approxBytes(rawParams) };
}

// ── Request log ────────────────────────────────────────────────────────────

export interface RequestLogEntry {
  ts: string;
  reqId: string;
  op: string;
  workspace: string; // tenancy identifier — needed for audit/leak-canary; NOT a param value
  principal: string;
  role: string;
  remote: boolean;
  params: ParamSummary | null;
  outcome: string; // a code/enum ('ok' | error code) — NEVER a message (review AM1)
  ms: number;
  /**
   * Low-cardinality DIMENSIONS of the request, for slicing the logs — never param values.
   *
   * `format` is the one entry today, and it is a deliberately scoped exception to D28's "shapes,
   * never values" rule, so the reasoning is written here rather than assumed. It is admissible only
   * because of where it comes from: `detect.ts`'s CLOSED UNION, decided from the file's magic bytes.
   * It is NOT the filename extension and NOT a caller-supplied MIME string — both are user-controlled
   * free text, and logging either would put attacker-chosen content into a JSON log line, which is
   * exactly the injection D28 exists to prevent.
   *
   * The value is worth the exception: "PDF ingests started failing this morning" is not a question
   * the logs could answer otherwise, and per-format failure rate is the first thing anyone looks at
   * when a parser regresses.
   */
  dims?: { format?: string };
}

export type LogSink = (entry: RequestLogEntry) => void;

/** Default sink: one structured JSON line to stdout. The M8 audit spine formalizes this. */
export const defaultLogSink: LogSink = (e) => {
  console.log(JSON.stringify({ level: 'info', kind: 'op_request', ...e }));
};
