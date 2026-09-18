// Shared shapes for the cycle engine (M8). Pure types — no DB, no imports beyond each other.

export type PhaseStatus = 'ok' | 'warn' | 'fail' | 'skipped';

export interface PhaseError {
  /** 'BudgetExhausted' | 'DatabaseConnection' | 'InternalError' | … — coarse enough to branch on,
   *  not a stack trace. */
  class: string;
  code: string;
  message: string;
}

export interface PhaseResult {
  phase: string;
  status: PhaseStatus;
  duration_ms: number;
  summary: string;
  details: Record<string, unknown>;
  error?: PhaseError;
}

export interface PhaseRunOpts {
  dryRun: boolean;
  /** Minted once by runCycle() before any phase runs; every phase in the run shares it. */
  runId: string;
  budgetUsdOverride?: number;
}

export interface CycleReport {
  workspace_id: string;
  run_id: string;
  timestamp: string;
  duration_ms: number;
  status: 'ok' | 'partial' | 'failed' | 'skipped';
  /** Set when status is 'skipped' or the run failed before any phase could start. */
  reason?: string;
  phases: PhaseResult[];
}

export interface CycleOpts {
  workspaceId: string;
  /** Defaults to every registered phase. */
  phases?: string[];
  dryRun?: boolean;
  budgetUsdOverride?: number;
  /** Default 30 (minutes). */
  lockTtlMinutes?: number;
}
