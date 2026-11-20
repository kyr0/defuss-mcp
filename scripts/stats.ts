/** VERIFIED: The benchmark drivers and reports share one median and one nearest-rank percentile. */
export function median(values: readonly number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}
/** Nearest rank: the smallest sample with at least p percent of samples at or below it. */
export function percentile(values: readonly number[], p: number) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((p * sorted.length + 99) / 100) - 1]!;
}
