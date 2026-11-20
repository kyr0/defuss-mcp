/** VERIFIED: Build an isolated package consumer and drive real client and server processes. */
import { spawn, type ChildProcess, type StdioOptions } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  accessSync,
  closeSync,
  constants,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { arch, availableParallelism, cpus, loadavg, platform, release, tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { coverage, SERVERS } from './clients.ts';
import { median, percentile } from './stats.ts';

const ROOT = resolve(import.meta.dirname, '..');
const PYTHON = join(ROOT, '.venv/bin/python');
const BASELINE = join(ROOT, 'vendor/baseline/defuss-mcp-0.4.0.tgz');
const BASELINE_SHA256 = 'cfce4106c75ec977b38c2d1ec4b48c3e1eaf537c61ce5acc93248ecd65b70193';
const CLIENTS = [
  ['node', 'client.ts'],
  ['bun', 'client.ts'],
  [PYTHON, 'client.py'],
] as const;
interface Row {
  client: string;
  mode: string;
  era?: string;
  server?: string;
  provider?: string;
  samplesMs?: number[];
  callsPerSecond?: number[];
  [key: string]: unknown;
}

const sha256 = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
function which(command: string) {
  for (const dir of (process.env.PATH ?? '').split(':')) {
    try {
      accessSync(join(dir, command), constants.X_OK);
      return join(dir, command);
    } catch {
      // Try the next PATH entry.
    }
  }
  throw new Error('Missing executable on PATH: ' + command);
}

// Each child leads its own process group, so a timeout or an interrupted driver also reaps grandchildren.
const live = new Set<ChildProcess>();
function killGroup(child: ChildProcess, signal: NodeJS.Signals) {
  try {
    process.kill(-child.pid!, signal);
  } catch {
    // The group already exited.
  }
}
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, () => {
    for (const child of live) killGroup(child, 'SIGKILL');
    process.exit(130);
  });
function start(args: readonly string[], cwd: string, stdio: StdioOptions) {
  const child = spawn(args[0]!, args.slice(1), { cwd, stdio, detached: true });
  live.add(child);
  // close fires after exit and after the child's pipes have drained.
  const closed = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => {
      live.delete(child);
      resolve(code);
    });
  });
  return { child, closed };
}
async function stop({ child, closed }: ReturnType<typeof start>) {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM');
    const timer = setTimeout(() => killGroup(child, 'SIGKILL'), 5000);
    await closed.finally(() => clearTimeout(timer));
  }
  // A server's own children must not outlive it.
  killGroup(child, 'SIGKILL');
}
/** Return stdout, or stderr when the expected exit code is nonzero. */
async function run(args: readonly string[], cwd: string, { timeoutMs = 120_000, expectedCode = 0 } = {}) {
  const { child, closed } = start(args, cwd, ['ignore', 'pipe', 'pipe']);
  let out = '',
    err = '';
  child.stdout!.on('data', (chunk: Buffer) => (out += chunk));
  child.stderr!.on('data', (chunk: Buffer) => (err += chunk));
  const timer = setTimeout(() => killGroup(child, 'SIGKILL'), timeoutMs);
  const code = await closed.finally(() => clearTimeout(timer));
  if (code !== expectedCode)
    throw new Error(`${args.join(' ')} exited ${code}\n${out.slice(-1400)}\n${err.slice(-7000)}`);
  return expectedCode ? err : out;
}

/** Install the packed tree (or the pinned v0.4.0 tarball) into an empty consumer, check what a user sees, return its digest. */
async function install(consumer: string, baseline: boolean, auditDocs: boolean) {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  if (baseline) {
    if (sha256(BASELINE) !== BASELINE_SHA256) throw new Error('Baseline package digest differs');
    copyFileSync(BASELINE, join(consumer, basename(BASELINE)));
  } else await run(['bun', 'pm', 'pack', '--destination', consumer], ROOT);
  const packed = readdirSync(consumer).find((name) => name.endsWith('.tgz'))!;
  const digest = sha256(join(consumer, packed));
  // Distinguish local rebuilds with the same version in Bun's package cache.
  const archive = packed.replace(/\.tgz$/, '-' + digest.slice(0, 16) + '.tgz');
  renameSync(join(consumer, packed), join(consumer, archive));
  const dependencies: Record<string, string> = {};
  for (const key of [
    'defuss-rpc',
    'express',
    'bunway',
    '@modelcontextprotocol/client',
    '@types/node',
    '@types/express',
    'typescript',
  ])
    dependencies[key] = manifest.devDependencies[key];
  dependencies['defuss-mcp'] = './' + archive;
  writeFileSync(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module', dependencies }));
  await run(['bun', 'install'], consumer);
  const pkg = join(consumer, 'node_modules/defuss-mcp');
  if (!baseline)
    for (const name of readdirSync(join(ROOT, 'dist')))
      if (!readFileSync(join(ROOT, 'dist', name)).equals(readFileSync(join(pkg, 'dist', name))))
        throw new Error('Installed package differs from this build: ' + name);
  if (auditDocs) {
    copyFileSync(join(ROOT, 'scripts/api-docs.ts'), join(consumer, 'api-docs.ts'));
    // Resolve the exact installed package rather than the producer's declarations.
    const metadata = await run(['bun', join(consumer, 'api-docs.ts')], pkg);
    if (!metadata.includes('documented declarations')) throw new Error('Missing documentation audit');
    copyFileSync(join(pkg, 'output/api-docs.json'), join(ROOT, 'output/api-docs.json'));
    await quickStart(consumer, pkg);
  }
  for (const name of ['client.ts', 'client.py', 'consumer.ts', 'soak-server.ts'])
    copyFileSync(join(ROOT, 'scripts', name), join(consumer, name));
  // Node strips types only outside node_modules, so the examples run from the consumer root.
  // The v0.4.0 example is plain JavaScript, which is also valid TypeScript.
  copyFileSync(join(pkg, 'examples', baseline ? 'server.mjs' : 'server.ts'), join(consumer, 'server.ts'));
  if (baseline) return digest;
  for (const name of ['math.mcp.ts', 'byte-add.ts', 'observed-stdio.ts'])
    copyFileSync(join(pkg, 'examples', name), join(consumer, name));
  const cli = join(consumer, 'node_modules/.bin/defuss-mcp');
  if (auditDocs && !(await run([cli], consumer, { expectedCode: 1 })).includes('--entry'))
    throw new Error('Installed CLI did not report its usage on missing arguments');
  // The published examples/tsconfig.json selects source-extension imports, so check the published pair in place.
  const examples = join(pkg, 'examples');
  await run([cli, '--entry', join(examples, 'byte-add.ts'), '--out', join(examples, 'math.mcp.ts'), '--check'], consumer);
  for (const name of ['signature-client.mts', 'signature-fixture.mts'])
    copyFileSync(join(ROOT, 'scripts', name), join(consumer, name));
  await run([cli, '--entry', 'signature-fixture.mts', '--out', 'generated.mts'], consumer);
  const tsc = ['bun', 'x', 'tsc', '--strict', '--skipLibCheck', '--module', 'NodeNext', '--target', 'ES2022'];
  await run([...tsc, '--outDir', 'compiled', 'signature-client.mts'], consumer);
  for (const runtime of ['node', 'bun']) await run([runtime, 'compiled/signature-client.mjs'], consumer);
  await run(
    ['node', '-e', "for(const p of ['','/rpc','/http','/validation','/stdio','/client'])require('defuss-mcp'+p)"],
    consumer,
  );
  await run([...tsc, '--declaration', '--emitDeclarationOnly', 'consumer.ts'], consumer);
  return digest;
}

/** Ask the OS for a free loopback port. */
async function freePort() {
  const probe = createServer().listen(0, '127.0.0.1');
  await new Promise((resolve) => probe.once('listening', resolve));
  const { port } = probe.address() as { port: number };
  await new Promise((resolve) => probe.close(resolve));
  return port;
}
/** Run the README quick start, as the installed package ships it, with its port replaced by a free one. */
async function quickStart(consumer: string, pkg: string) {
  const section = readFileSync(join(pkg, 'README.md'), 'utf8').split('\n## Quick start\n')[1]?.split('\n## ')[0];
  const blocks = [...(section ?? '').matchAll(/```ts\n([\s\S]*?)```/g)].map((match) => match[1]!);
  if (blocks.length !== 2) throw new Error('The README quick start needs one server and one client block');
  const port = String(await freePort());
  const dir = join(consumer, 'quickstart');
  mkdirSync(dir);
  writeFileSync(join(dir, 'server.ts'), blocks[0]!.replaceAll('3000', port));
  writeFileSync(join(dir, 'client.ts'), blocks[1]!.replaceAll('3000', port));
  const server = start(['bun', 'server.ts'], dir, 'ignore');
  try {
    for (const deadline = Date.now() + 15_000; ; ) {
      try {
        await fetch('http://127.0.0.1:' + port + '/mcp');
        break;
      } catch (error) {
        if (Date.now() > deadline || server.child.exitCode !== null) throw error;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    const printed = await run(['bun', 'client.ts'], dir, { timeoutMs: 20_000 });
    if (!printed.includes('Hello, Ada')) throw new Error('The README quick start printed ' + printed);
  } finally {
    await stop(server);
  }
}

/** The URL of the first JSON log line that has one: this release's listening event or v0.4.0's bare {url}. */
function readyUrl(log: string) {
  for (const line of log.split('\n')) {
    if (!line.startsWith('{')) continue;
    try {
      const { url } = JSON.parse(line);
      if (typeof url === 'string') return url;
    } catch {
      // Ignore partial lines and other output.
    }
  }
}
/** Run use against a fresh server process, polling its log file for readiness, and always stop the process group. */
async function withListener<T>(
  runtime: string,
  provider: string,
  consumer: string,
  use: (url: string, pid: number) => Promise<T>,
  script = 'server.ts',
) {
  const log = join(consumer, `server-${runtime}-${provider}.log`);
  const fd = openSync(log, 'w');
  const server = start([runtime, script, provider], consumer, ['ignore', fd, fd]);
  closeSync(fd);
  try {
    const deadline = Date.now() + 15_000;
    let data = '';
    while (Date.now() < deadline) {
      data = readFileSync(log, 'utf8');
      const url = readyUrl(data);
      if (url) return await use(url, server.child.pid!);
      if (server.child.exitCode !== null) break;
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    throw new Error('Server startup: ' + data);
  } finally {
    await stop(server);
  }
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    smoke: { type: 'boolean', default: false },
    // Benchmark the bundled v0.4.0 package.
    baseline: { type: 'boolean', default: false },
  },
});
const action = positionals[0] ?? '';
if (!['test', 'bench', 'binary', 'large', 'soak'].includes(action) || positionals.length !== 1)
  throw new Error('Usage: bun scripts/matrix.ts test|bench|binary|large|soak [--smoke] [--baseline]');
if (values.baseline && !['bench', 'binary'].includes(action))
  throw new Error('Use --baseline with the scalar or binary benchmark');
const out = join(ROOT, 'output');
mkdirSync(out, { recursive: true });
const rows: Row[] = [];
const work = mkdtempSync(join(tmpdir(), 'defuss-mcp-consumer-'));
let packageSha256: string;
try {
  packageSha256 = await install(work, values.baseline, action === 'test');
  if (action === 'test')
    await run(['go', 'build', '-mod=readonly', '-o', join(work, 'go-interop'), '.'], join(ROOT, 'tests/interop-go'));

  // Server memory does not depend on the client's runtime, so the soak and large-payload runs use the Bun client.
  const clients = ['soak', 'large'].includes(action) ? CLIENTS.filter(([program]) => program === 'bun') : CLIENTS;
  const measure = async (target: string, runtime: string, provider: string, pid = 0) => {
    for (const [program, script] of clients) {
      console.log(action, runtime, provider, basename(program));
      const output = await run([program, script, action, target, which(runtime), String(pid)], work, {
        timeoutMs: 300_000,
      });
      const reports: Row[] = JSON.parse(output.trim().split('\n').at(-1)!);
      for (const row of reports) {
        Object.assign(row, { server: runtime, provider });
        if (row.samplesMs) {
          const samples = row.samplesMs;
          const mean = samples.reduce((sum, x) => sum + x, 0) / samples.length;
          Object.assign(row, {
            medianMs: median(samples),
            p95Ms: percentile(samples, 95),
            medianCallsPerSecond: median(row.callsPerSecond ?? [1000 / mean]),
          });
        }
        rows.push(row);
      }
    }
    if (action !== 'test') return;
    for (const mode of target === 'stdio' ? ['stdio'] : ['json', 'sse', 'auto']) {
      const endpoint = target === 'stdio' ? 'stdio' : target + '/mcp/' + mode;
      await run([join(work, 'go-interop'), endpoint, which(runtime)], work);
      rows.push({ client: 'go', mode, era: 'sdk-default', server: runtime, provider });
      // An ad-hoc target uses no persistent Inspector catalog.
      const cliTarget =
        mode === 'stdio'
          ? [which(runtime), 'server.ts', 'stdio']
          : [endpoint, '--transport', 'http', '--header', 'x-demo-key: demo', 'x-scope: read'];
      const reply = JSON.parse(
        await run(
          [
            join(ROOT, 'node_modules/.bin/mcp-inspector'),
            '--cli',
            ...cliTarget,
            '--method',
            'tools/call',
            '--tool-name',
            'byteAdd',
            '--tool-args-json',
            '{"a":"AQI=","b":"AwQ="}',
          ],
          work,
        ),
      );
      if (reply.isError || JSON.stringify(reply.structuredContent) !== '{"value":"BAY="}')
        throw new Error('Inspector byteAdd result: ' + JSON.stringify(reply));
      // The Inspector passes arguments on its command line, so only the download direction is large.
      const size = (mode === 'stdio' ? 6 : 11) * 1024 * 1024;
      const download = JSON.parse(
        await run(
          [
            join(ROOT, 'node_modules/.bin/mcp-inspector'),
            '--cli',
            ...cliTarget,
            '--method',
            'tools/call',
            '--tool-name',
            'bytes.pattern',
            '--tool-args-json',
            JSON.stringify({ size }),
          ],
          work,
        ),
      );
      const received = Buffer.from(download.structuredContent?.value?.bytes ?? '', 'base64');
      if (download.isError || !received.equals(Buffer.from(Array.from({ length: size }, (_, i) => (i * 37 + 11) & 255))))
        throw new Error(`Inspector download of ${size} bytes differs from the pattern`);
      rows.push({ client: 'inspector-cli', mode, era: 'cli-default', server: runtime, provider });
    }
  };
  for (const [runtime, provider] of values.smoke ? SERVERS.slice(0, 1) : SERVERS)
    await withListener(
      runtime,
      provider,
      work,
      (url, pid) => measure(url, runtime, provider, pid),
      action === 'soak' ? 'soak-server.ts' : 'server.ts',
    );
  if (!values.smoke) for (const runtime of ['node', 'bun']) await measure('stdio', runtime, 'child');
} finally {
  rmSync(work, { recursive: true, force: true });
}

if (action === 'test') {
  const { missing, extra, duplicates } = coverage(rows, values.smoke);
  if (missing.length || extra.length || duplicates.length)
    throw new Error(`Client matrix mismatch: missing=${missing}, extra=${extra}, duplicates=${duplicates}`);
}
const version = async (args: string[], cwd = ROOT) => (await run(args, cwd)).trim();
const packageVersion = (name: string) =>
  JSON.parse(readFileSync(join(ROOT, 'node_modules', name, 'package.json'), 'utf8')).version as string;
const environment: Record<string, unknown> = {
  packageSha256,
  finishedUtc: new Date().toISOString(),
  availableCpus: availableParallelism(),
  platform: `${platform()}-${release()}-${arch()}`,
  cpu: arch(),
  cpuModel: cpus()[0]?.model,
  // Other host work shares these CPUs; record its load beside the timings.
  loadAverage: loadavg(),
  node: await version(['node', '-v']),
  bun: await version(['bun', '--version']),
  python: (await version([PYTHON, '--version'])).split(' ')[1],
  pythonMcp: await version([PYTHON, '-c', 'import importlib.metadata as m; print(m.version("mcp"))']),
  tsSdk: packageVersion('@modelcontextprotocol/client'),
};
if (action === 'test')
  Object.assign(environment, {
    go: await version(['go', 'version']),
    goMcp: (await version(['go', 'list', '-m', 'github.com/modelcontextprotocol/go-sdk'], join(ROOT, 'tests/interop-go')))
      .split(' ')
      .at(-1),
    inspector: packageVersion('@modelcontextprotocol/inspector'),
  });
const name =
  (action === 'test' ? 'e2e' : action) + (values.baseline ? '-baseline' : '') + (values.smoke ? '-smoke' : '');
writeFileSync(join(out, name + '.json'), JSON.stringify({ environment, rows }, null, 2) + '\n');
console.log(`${rows.length} ${name} rows verified`);
