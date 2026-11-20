/** VERIFIED: Write the table of one evidence file to stdout without changing the measured evidence. */
import { readFileSync } from 'node:fs';
import { median } from './stats.ts';

interface BenchRow {
  server: string;
  provider: string;
  client: string;
  mode: string;
  method: string;
  medianCallsPerSecond: number;
  medianMs: number;
  p95Ms: number;
  concurrency8CallsPerSecond: number[];
}
interface LargeRow extends BenchRow {
  bytes: number;
  movedBytes: number;
  serverRssBeforeBytes: number;
  serverRssPeakBytes: number;
}
interface SoakRow {
  server: string;
  provider: string;
  mode: string;
  callsPerRound: number;
  heapBytes: number[];
  growthBytes: number;
  limitBytes: number;
  largeGrowthBytes: number;
  bounded: boolean;
}
const MiB = 1024 * 1024;
const mib = (bytes: number) => (bytes / MiB).toFixed(1);
const kib = (bytes: number) => (bytes / 1024).toFixed(0);
const rows = JSON.parse(readFileSync(process.argv[2]!, 'utf8')).rows;
// Each evidence file has its own row shape: soak rows carry heap samples, large-transfer rows the moved bytes.
if ('heapBytes' in rows[0]) {
  console.log('| Server | Provider | Mode | Calls | Floor growth KiB | Limit KiB | 1 MiB batch growth KiB | Bounded |');
  console.log('|---|---|---|---|---:|---:|---:|---|');
  for (const r of rows as SoakRow[])
    console.log(
      `| ${r.server} | ${r.provider} | ${r.mode} | ${(r.heapBytes.length + 1) * r.callsPerRound} | ${kib(r.growthBytes)} | ${kib(r.limitBytes)} | ${kib(r.largeGrowthBytes)} | ${r.bounded ? 'yes' : 'no'} |`,
    );
} else if ('movedBytes' in rows[0]) {
  console.log('| Server | Provider | Mode | Direction | MiB | p50 ms | MiB/s moved | Server RSS before MiB | Peak MiB |');
  console.log('|---|---|---|---|---:|---:|---:|---:|---:|');
  for (const r of rows as LargeRow[])
    console.log(
      `| ${r.server} | ${r.provider} | ${r.mode} | ${r.method} | ${mib(r.bytes)} | ${r.medianMs.toFixed(1)} | ${(r.movedBytes / MiB / (r.medianMs / 1000)).toFixed(0)} | ${mib(r.serverRssBeforeBytes)} | ${mib(r.serverRssPeakBytes)} |`,
    );
} else {
  console.log('| Server | Provider | Client | Mode | Call | Serial calls/s | p50 ms | p95 ms | Eight in flight, calls/s |');
  console.log('|---|---|---|---|---|---:|---:|---:|---:|');
  for (const r of rows as BenchRow[])
    console.log(
      `| ${r.server} | ${r.provider} | ${r.client} | ${r.mode} | ${r.method} | ${r.medianCallsPerSecond.toFixed(0)} | ${r.medianMs.toFixed(3)} | ${r.p95Ms.toFixed(3)} | ${median(r.concurrency8CallsPerSecond).toFixed(0)} |`,
    );
}
