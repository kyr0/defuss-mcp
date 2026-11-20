/** VERIFIED: The website's figures come from one verified run of one package version, copied into a small committed snapshot. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { median } from './stats.ts';

const ROOT = resolve(import.meta.dirname, '..');
const OUT = join(ROOT, 'site/data/evidence.json');
const read = (name: string) => JSON.parse(readFileSync(join(ROOT, 'output', name), 'utf8'));

interface Row {
  server: string;
  provider: string;
  client: string;
  mode: string;
  method: string;
  medianMs: number;
  p95Ms: number;
  medianCallsPerSecond: number;
  concurrency8CallsPerSecond: number[];
  bytes?: number;
}
interface CompareRow {
  label: string;
  medianRoundP50Ms: number[];
  medianPairedChangePercent: number;
}

const version: string = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
const e2e = read('e2e.json');
const bench = read('bench.json');
const binary = read('binary.json');
for (const [name, evidence] of [
  ['bench.json', bench],
  ['binary.json', binary],
] as const)
  if (evidence.environment.packageSha256 !== e2e.environment.packageSha256)
    throw new Error(`output/${name} measured another tarball than output/e2e.json; rerun make verify and make bench`);

const latency = (bench.rows as Row[])
  .filter((r) => r.client === 'bun' && ['json', 'stdio', 'http'].includes(r.mode))
  .filter((r) => ['rpc', 'mcp-functions-auto'].includes(r.method))
  .map((r) => ({
    server: r.server,
    provider: r.provider,
    method: r.method,
    p50Ms: r.medianMs,
    p95Ms: r.p95Ms,
    serialPerSecond: r.medianCallsPerSecond,
    eightInFlightPerSecond: median(r.concurrency8CallsPerSecond),
  }));
const throughput = (binary.rows as Row[])
  .filter((r) => r.server === 'node' && r.provider === 'express' && r.client === 'node' && r.bytes === 65536)
  .filter((r) => r.mode === 'json' || r.mode === 'http')
  .map((r) => ({
    method: r.method,
    p50Ms: r.medianMs,
    mibPerSecond: (2 * r.bytes! * median(r.concurrency8CallsPerSecond)) / 1048576,
  }));
const coldStart = ['node', 'bun'].map((runtime) => {
  const evidence = read('compare-' + runtime + '.json');
  if (evidence.environment.packageSha256 !== e2e.environment.packageSha256)
    throw new Error(`output/compare-${runtime}.json measured another tarball; rerun make bench`);
  const row = (evidence.rows as CompareRow[]).find((r) => r.label.startsWith('Import index and http entries'));
  if (!row) throw new Error('compare-' + runtime + '.json has no cold import row; rerun make bench');
  const [baseline, current] = row.medianRoundP50Ms as [number, number];
  return { runtime, baselineVersion: evidence.versions[0], baselineMs: baseline, currentMs: current };
});

const snapshot = {
  version,
  packageSha256: e2e.environment.packageSha256,
  measuredAt: bench.environment.finishedUtc,
  host: {
    cpuModel: e2e.environment.cpuModel,
    platform: e2e.environment.platform,
    node: String(e2e.environment.node).replace(/^v/, ''),
    bun: e2e.environment.bun,
    python: e2e.environment.python,
    pythonMcp: e2e.environment.pythonMcp,
    tsSdk: e2e.environment.tsSdk,
    go: /go(\d[\d.]*)/.exec(String(e2e.environment.go))?.[1] ?? String(e2e.environment.go),
    goMcp: e2e.environment.goMcp,
    inspector: e2e.environment.inspector,
  },
  loadAverage: bench.environment.loadAverage,
  cells: (e2e.rows as Row[]).map(({ server, provider, client, mode }) => ({ server, provider, client, mode })),
  latency,
  throughput,
  coldStart,
};
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(snapshot, null, 2) + '\n');
console.log(`site/data/evidence.json: ${snapshot.cells.length} client cells, version ${version}`);
