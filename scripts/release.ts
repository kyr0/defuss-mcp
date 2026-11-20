/** VERIFIED: Package the checked source tree, compiled package, matching evidence and SHA-256 manifest. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';
import { releaseFiles } from './release-files.ts';
import { median } from './stats.ts';
import { attestations } from './vae.ts';

const root = process.cwd();
const out = join(root, 'output');
const proof = join(root, 'validation');
mkdirSync(proof, { recursive: true });
const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const json = (file: string) => JSON.parse(readFileSync(join(proof, file), 'utf8'));
const signed = (value: number, digits = 1) => (value >= 0 ? '+' : '') + value.toFixed(digits);
// Invoking the packager directly must check the current code just as make release does.
execFileSync('bun', ['scripts/gate.ts'], { stdio: 'inherit' });
for (const [src, dest] of [
  ['e2e.json', 'e2e.json'],
  ['api-docs.json', 'api-docs.json'],
  ['unit-tests.json', 'unit-tests.json'],
  ['add-node.json', 'add-node.json'],
  ['add-bun.json', 'add-bun.json'],
  ['coverage/coverage-summary.json', 'coverage-summary.json'],
  ['bench.json', 'bench.json'],
  ['binary.json', 'binary.json'],
  ['binary-baseline.json', 'binary-baseline.json'],
  ['bench-baseline.json', 'bench-baseline.json'],
  ['compare-node.json', 'compare-node.json'],
  ['compare-bun.json', 'compare-bun.json'],
  ['soak.json', 'soak.json'],
  ['large.json', 'large.json'],
  ['vae-gate.txt', 'vae-gate.txt'],
] as const)
  copyFileSync(join(out, src), join(proof, dest));
const table = (file: string) => execFileSync('bun', ['scripts/metrics.ts', join(out, file)], { encoding: 'utf8' });
writeFileSync(
  join(proof, 'benchmarks.md'),
  table('bench.json') +
    '\n## Large transfers\n\n' +
    table('large.json') +
    '\n## Memory soak\n\nRetained heap after forced collection; see docs/VERIFICATION.md#memory-soak.\n\n' +
    table('soak.json'),
);
for (const [kind, path] of Object.entries(attestations('release')))
  if (existsSync(path)) copyFileSync(path, join(proof, kind + '.json'));
execFileSync('bun', ['pm', 'pack', '--destination', proof], { stdio: 'inherit' });
const version: string = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const packedHash = sha256(readFileSync(join(proof, `defuss-mcp-${version}.tgz`)));
for (const file of [
  'e2e.json',
  'add-node.json',
  'add-bun.json',
  'bench.json',
  'binary.json',
  'compare-node.json',
  'compare-bun.json',
  'soak.json',
  'large.json',
])
  if (json(file).environment.packageSha256 !== packedHash)
    throw new Error(`${file} came from a different tarball. Rerun make verify and make bench.`);

interface Row {
  server: string;
  provider: string;
  client: string;
  mode: string;
  method: string;
  bytes: number;
  medianMs: number;
  p95Ms: number;
  medianCallsPerSecond: number;
  concurrency8CallsPerSecond: number[];
}
const old = json('bench-baseline.json');
const baselineDigest = sha256(readFileSync(join(root, 'vendor/baseline/defuss-mcp-0.4.0.tgz')));
if (old.environment.packageSha256 !== baselineDigest) throw new Error('Baseline matrix came from a different tarball.');
const key = (row: Row) => [row.server, row.provider, row.client, row.mode, row.method];
const sameScenarios = (a: Map<string, Row>, b: Row[], id: (row: Row) => string) =>
  a.size === new Set(b.map(id)).size && b.every((row) => a.has(id(row)));
const scalarId = (row: Row) => key(row).join(' ');
const previous = new Map<string, Row>(old.rows.map((row: Row) => [scalarId(row), row]));
const current: Row[] = json('bench.json').rows;
if (!sameScenarios(previous, current, scalarId)) throw new Error('Version matrices cover different scenarios.');
let text =
  `# Scalar matrix, v0.4.0 to v${version}\n\nIndependent complete runs on this host. Percent changes relative to v0.4.0. Rates include result checks.\n\n` +
  '| Server | Provider | Client | Mode | Method | p50 time | p95 time | Serial calls/s | Eight in flight calls/s |\n|---|---|---|---|---|---:|---:|---:|---:|\n';
for (const row of current) {
  const base = previous.get(scalarId(row))!;
  const pairs = [
    [row.medianMs, base.medianMs],
    [row.p95Ms, base.p95Ms],
    [row.medianCallsPerSecond, base.medianCallsPerSecond],
    [median(row.concurrency8CallsPerSecond), median(base.concurrency8CallsPerSecond)],
  ];
  text += `| ${key(row).join(' | ')} | ${pairs.map(([after, before]) => signed((after! / before! - 1) * 100) + '%').join(' | ')} |\n`;
}
writeFileSync(join(proof, 'matrix-changes.md'), text);

const binaryBaseline = json('binary-baseline.json');
if (binaryBaseline.environment.packageSha256 !== baselineDigest) throw new Error('Binary matrix baseline digest differs.');
const binaryId = (row: Row) => [...key(row), row.bytes].join(' ');
const oldBinary = new Map<string, Row>(binaryBaseline.rows.map((row: Row) => [binaryId(row), row]));
const currentBinary: Row[] = json('binary.json').rows;
if (!sameScenarios(oldBinary, currentBinary, binaryId))
  throw new Error('Binary version matrices cover different scenarios.');
text =
  `# Binary echo, v0.4.0 and v${version}\n\nRequest and response each carry the listed payload. Useful MiB/s counts both directions at eight in flight. The full matrices ran separately on the same host.\n\n` +
  '| Server | Provider | Client | Mode | Method | Bytes | Baseline p50 ms | Current p50 ms | Baseline p95 ms | Current p95 ms | Baseline MiB/s | Current MiB/s |\n|---|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|\n';
for (const row of currentBinary) {
  const base = oldBinary.get(binaryId(row))!;
  const [before, after] = [base, row].map((r) => (median(r.concurrency8CallsPerSecond) * 2 * row.bytes) / 1048576);
  text += `| ${key(row).join(' | ')} | ${row.bytes} | ${base.medianMs.toFixed(3)} | ${row.medianMs.toFixed(3)} | ${base.p95Ms.toFixed(3)} | ${row.p95Ms.toFixed(3)} | ${before!.toFixed(2)} | ${after!.toFixed(2)} |\n`;
}
writeFileSync(join(proof, 'binary.md'), text);

text =
  '# Paired release measurements\n\nMedian round p50 in milliseconds. Change is the median of eight within-round percentages.\n\n' +
  `| Runtime | Workload | v0.4.0 ms | v${version} ms | Paired change | Faster rounds |\n|---|---|---:|---:|---:|---:|\n`;
let wire =
  '\n## HTTP body sizes\n\nOne untimed request per client and release. Byte counts include the JSON-RPC envelope.\n\n' +
  '| Runtime | Workload | Baseline request B | Current request B | Baseline reply B | Current reply B |\n|---|---|---:|---:|---:|---:|\n';
for (const runtime of ['node', 'bun']) {
  const evidence = json('compare-' + runtime + '.json');
  for (const row of evidence.rows) {
    const [before, after] = row.medianRoundP50Ms;
    text += `| ${runtime} | ${row.label} | ${before.toFixed(3)} | ${after.toFixed(3)} | ${signed(row.medianPairedChangePercent)}% | ${row.candidateFasterRounds}/${evidence.rounds} |\n`;
    if (row.wire) {
      const [a, b] = row.wire;
      wire += `| ${runtime} | ${row.label} | ${a.requestBytes} | ${b.requestBytes} | ${a.replyBytes} | ${b.replyBytes} |\n`;
    }
  }
}
writeFileSync(join(proof, 'comparison.md'), text + wire);

// Report nearest-rank percentiles already computed from verified complete round trips.
text =
  '# Two-operand byte addition over Express\n\nOne serial call with two equal-size inputs and one equal-size output. JS clients and servers run in separate processes on the same runtime. Python uses the same server in a separate pass. All sizes are per operand. File logging includes two awaited appends to a local file per call. See docs/VERIFICATION.md for sampling and body limits.\n\n' +
  '| Server | Client | Configuration | Bytes | Samples | p50 ms | p95 ms | At eight in flight, calls/s |\n|---|---|---|---:|---:|---:|---:|---:|\n';
for (const runtime of ['node', 'bun']) {
  const data = json(`add-${runtime}.json`);
  if (data.environment.baselineSha256 !== baselineDigest)
    throw new Error('Byte-add evidence baseline differs from the bundled v0.4.0 tarball.');
  for (const row of data.rows) {
    const rate = row.concurrency8CallsPerSecond.length ? median(row.concurrency8CallsPerSecond).toFixed(0) : '';
    text += `| ${runtime} | ${runtime} | ${row.lane} | ${row.bytes} | ${row.n} | ${row.p50.toFixed(3)} | ${row.p95.toFixed(3)} | ${rate} |\n`;
  }
  for (const row of data.python)
    text += `| ${runtime} | python | off | ${row.bytes} | ${row.n} | ${row.p50.toFixed(3)} | ${row.p95.toFixed(3)} | |\n`;
}
writeFileSync(join(proof, 'add.md'), text);

/** Minimal deflated ZIP without ZIP64: the archive stays far below 4 GiB and 65,535 entries. */
function zip(entries: { name: string; data: Buffer; mode: number }[]) {
  const now = new Date();
  const time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const locals: Buffer[] = [],
    central: Buffer[] = [];
  let offset = 0;
  for (const { name, data, mode } of entries) {
    const path = Buffer.from(name, 'utf8'),
      packed = deflateRawSync(data),
      crc = crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0800, 6); // UTF-8 names
    header.writeUInt16LE(8, 8); // deflate
    header.writeUInt16LE(time, 10);
    header.writeUInt16LE(date, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(packed.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(path.length, 26);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE((3 << 8) | 20, 4); // made by Unix, so the mode below applies
    header.copy(entry, 6, 4, 30);
    entry.writeUInt32LE(((mode & 0xffff) << 16) >>> 0, 38);
    entry.writeUInt32LE(offset, 42);
    locals.push(header, path, packed);
    central.push(entry, path);
    offset += header.length + path.length + packed.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  if (entries.length > 0xffff || offset + directory.length > 0xffffffff) throw new Error('Archive needs ZIP64.');
  return Buffer.concat([...locals, directory, end]);
}

const entries = releaseFiles(root, version, packedHash).map((file) => ({
  name: 'defuss-mcp/' + file.split('\\').join('/'),
  data: readFileSync(join(root, file)),
  mode: lstatSync(join(root, file)).mode,
}));
const sums = entries.map(({ name, data }) => sha256(data) + '  ' + name.slice('defuss-mcp/'.length)).join('\n') + '\n';
entries.push({ name: 'defuss-mcp/SHA256SUMS', data: Buffer.from(sums), mode: 0o100644 });
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('.', '').replace('Z', '000Z');
const zipPath = join(out, `defuss-mcp-v${version}-${stamp}.zip`);
writeFileSync(zipPath, zip(entries));
console.log(zipPath);
