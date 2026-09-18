/** Pure recency primitives ported from gbrain commit
 * 8c70f6255047a7647adb30b1d6333a48068d9fa5 under MIT (see NOTICE). */

export type EffectiveRecencyMode = 'off' | 'on' | 'strong';

export interface RecencyDecayOptions {
  mode: EffectiveRecencyMode;
  halflifeDays: number;
  coefficient: number;
}

/** Hyperbolic freshness factor. Missing/invalid dates, disabled modes, and zero knobs are neutral. */
export function recencyFactor(
  effectiveDate: string | Date | null | undefined,
  asOf: string | Date,
  options: RecencyDecayOptions,
): number {
  if (options.mode === 'off' || options.halflifeDays === 0 || options.coefficient === 0 || !effectiveDate) {
    return 1;
  }
  const effectiveMs = new Date(effectiveDate).getTime();
  const asOfMs = new Date(asOf).getTime();
  if (!Number.isFinite(effectiveMs) || !Number.isFinite(asOfMs)) return 1;
  const daysOld = Math.max(0, (asOfMs - effectiveMs) / 86_400_000);
  const component = options.coefficient * options.halflifeDays / (options.halflifeDays + daysOld);
  return 1 + (options.mode === 'strong' ? 1.5 : 1) * component;
}
