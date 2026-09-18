// Adapter registry. `--dataset <name>` resolves through here.
//
// Adding a benchmark is one new file plus one line below. Nothing in the core, the loader, the
// scorer or the report changes — that separation is the entire reason the adapter seam exists.
import type { DatasetAdapter } from '../types.ts';
import { multihopAdapter } from './multihop.ts';
import { ragtestAdapter } from './ragtest.ts';
import { singletopicAdapter } from './singletopic.ts';

const ADAPTERS: DatasetAdapter[] = [multihopAdapter, ragtestAdapter, singletopicAdapter];

export const DEFAULT_DATASET = 'multihop';

export function adapterNames(): string[] {
  return ADAPTERS.map((a) => a.name).sort();
}

/** Throws with the available names rather than returning undefined — a typo'd `--dataset` should
 *  tell the caller what to type next, not fail later as a confusing "no documents found". */
export function resolveAdapter(name: string): DatasetAdapter {
  const found = ADAPTERS.find((a) => a.name === name);
  if (!found) {
    throw new Error(`unknown --dataset "${name}". Available: ${adapterNames().join(', ')}`);
  }
  return found;
}

export { multihopAdapter, ragtestAdapter, singletopicAdapter };
