/**
 * Small, pure statistics helpers shared by scenario models.
 */

/**
 * Computes the 95th percentile (nearest-rank) from a list of values, or null if empty.
 */
export function computeP95(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * 0.95) - 1));
  return sorted[idx] ?? null;
}
