// The evidence snapshot behind every figure on the page. scripts/site-data.ts
// copies it from one verified run in output/; the build refuses a snapshot of
// another package version.
import { readFileSync } from 'node:fs';

export interface Evidence {
  version: string;
  packageSha256: string;
  measuredAt: string;
  host: Record<'cpuModel' | 'platform' | 'node' | 'bun' | 'python' | 'pythonMcp' | 'tsSdk' | 'go' | 'goMcp' | 'inspector', string>;
  loadAverage: number[];
  cells: { server: string; provider: string; client: string; mode: string }[];
  latency: { server: string; provider: string; method: string; p50Ms: number; p95Ms: number; serialPerSecond: number; eightInFlightPerSecond: number }[];
  throughput: { method: string; p50Ms: number; mibPerSecond: number }[];
  coldStart: { runtime: string; baselineVersion: string; baselineMs: number; currentMs: number }[];
}

const repo = (path: string) => new URL('../../' + path, import.meta.url);

export function loadEvidence(): Evidence {
  const evidence = JSON.parse(readFileSync(repo('site/data/evidence.json'), 'utf8')) as Evidence;
  const { version } = JSON.parse(readFileSync(repo('package.json'), 'utf8')) as { version: string };
  if (evidence.version !== version)
    throw new Error(`site/data/evidence.json describes ${evidence.version}, the package is ${version}: run make verify and make bench, then bun scripts/site-data.ts`);
  return evidence;
}
