/** VERIFIED: Compare ordinary typed method calls on separate client/server processes sharing one Express listener. */
import { add, contracts } from '../examples/math.mcp.ts';
import assert from 'node:assert/strict';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, open, readFile, rm, writeFile } from 'node:fs/promises';
import { cpus, loadavg } from 'node:os';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { CallEvent } from 'defuss-mcp';
import { getRpcClient } from 'defuss-rpc/client';
import { createRpcServer } from 'defuss-rpc/server';
import { ExpressRpcServer } from 'defuss-rpc/express-server';
import { expressProvider } from 'defuss-rpc/providers/express';
import { percentile } from './stats.ts';

type Add = (a: Uint8Array, b: Uint8Array) => Promise<Uint8Array>;

const identity = { name: 'math', version: '1' };
const lanes = ['previous', 'off', 'observe', 'process', 'file', 'rpc'];
const runtime = process.versions.bun ? 'bun' : 'node';
const version = JSON.parse(await readFile('package.json', 'utf8')).version;
const previous = '0.4.0';
const rounds = lanes.length;
// Both extracted releases load at runtime, so their exports stay untyped here.
const load = (dir: string, release: string, part: string) =>
  import(pathToFileURL(resolve(dir, release, 'dist', part + '.mjs')).href);

async function serve(dir: string) {
  createRpcServer({ math: { add } });
  const limit = 16 * 1024 * 1024;
  const service = new ExpressRpcServer({
    provider: expressProvider(),
    host: '127.0.0.1',
    port: 0,
    jsonSizeLimit: limit,
  });
  const endpoints: { close(): Promise<void> }[] = [];
  const log = await open(resolve(dir, 'events.jsonl'), 'a');
  let pendingWrite = Promise.resolve();
  const counts = { start: 0, finish: 0, before: 0, after: 0 };
  try {
    for (const lane of lanes.filter((x) => x !== 'rpc')) {
      const release = lane === 'previous' ? previous : version;
      const { createMcpApi, bindContract } = await load(dir, release, 'index');
      if (lane !== 'previous') bindContract(add, contracts.add);
      const { createMcpHttp } = await load(dir, release, 'http');
      const api = createMcpApi({ name: 'math', version: '1' }, { add });
      if (lane === 'observe')
        api.observeCalls((event: CallEvent) => {
          counts[event.phase]++;
        });
      if (lane === 'process')
        api.processCalls({
          before() {
            counts.before++;
          },
          after() {
            counts.after++;
          },
        });
      if (lane === 'file')
        api.observeCalls((event: CallEvent) => {
          const line = JSON.stringify({ time: new Date().toISOString(), level: 'info', ...event }) + '\n';
          // Serialize writes to the shared file handle when clients overlap.
          pendingWrite = pendingWrite.then(() => log.appendFile(line));
          return pendingWrite;
        });
      const http = createMcpHttp(api, { maxBodyBytes: limit });
      service.getApp().all('/' + lane, http.middleware);
      endpoints.push(http);
    }
    const { url } = await service.start();
    process.stdout.write(JSON.stringify({ url }) + '\n');
    // The parent closing stdin also cleans up the fixture after a failed benchmark.
    for await (const _ of process.stdin) {
      /* EOF triggers shutdown. */
    }
  } finally {
    await Promise.all(endpoints.map((http) => http.close()));
    await service.stop();
    await log.close();
    await writeFile(resolve(dir, 'counts.json'), JSON.stringify(counts));
  }
}

async function benchmark() {
  await mkdir('tmp', { recursive: true });
  await mkdir('output', { recursive: true });
  const dir = await mkdtemp(resolve('tmp', 'add-'));
  const clients: Client[] = [],
    rows: Record<string, unknown>[] = [],
    hashes: Record<string, string> = {};
  let child: ChildProcess | undefined, exited: Promise<number | null> | undefined;
  try {
    execFileSync('bun', ['pm', 'pack', '--destination', dir], { stdio: 'pipe' });
    for (const release of [previous, version]) {
      const archive = resolve(
        release === previous ? 'vendor/baseline' : dir,
        'defuss-mcp-' + release + '.tgz',
      );
      hashes[release] = createHash('sha256')
        .update(await readFile(archive))
        .digest('hex');
      if (release === previous)
        assert.equal(hashes[release], 'cfce4106c75ec977b38c2d1ec4b48c3e1eaf537c61ce5acc93248ecd65b70193');
      const target = resolve(dir, release);
      await mkdir(target);
      execFileSync('tar', ['-xzf', archive, '--strip-components=1', '-C', target]);
    }
    child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--serve', dir], {
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    const server = child;
    exited = new Promise((res, rej) => {
      server.once('error', rej);
      server.once('exit', res);
    });
    const lines = createInterface({ input: child.stdout! });
    let url: string | undefined;
    for await (const line of lines) {
      if (line.startsWith('{"url":')) {
        url = JSON.parse(line).url;
        break;
      }
    }
    assert.ok(url, 'Child failed to start');
    const calls: Record<string, Add> = {};
    const rpc = await getRpcClient<{ math: { add: Add } }>({ baseUrl: url });
    calls.rpc = (a, b) => rpc.math.add(a, b);
    for (const lane of lanes.filter((x) => x !== 'rpc')) {
      const sdk = new Client(identity);
      clients.push(sdk);
      await sdk.connect(new StreamableHTTPClientTransport(new URL(url + '/' + lane)));
      const { getMcpClient } = await load(dir, lane === 'previous' ? previous : version, 'client');
      const { tools } = await getMcpClient(sdk);
      calls[lane] = (a, b) => tools.add(a, b);
    }
    let perLaneCalls = 0;
    for (const [bytes, n, warmup] of [
      [2, 40, 32],
      [4096, 32, 16],
      [65536, 12, 6],
      [1048576, 4, 3],
    ] as const) {
      const a = new Uint8Array(bytes + 2).subarray(1, bytes + 1),
        b = new Uint8Array(bytes + 4).subarray(2, bytes + 2);
      const expected = Buffer.alloc(bytes);
      for (let i = 0; i < bytes; i++) {
        a[i] = bytes === 2 ? i + 1 : (i * 37 + 11) & 255;
        b[i] = bytes === 2 ? i + 3 : (i * 19 + 29) & 255;
        expected[i] = (a[i]! + b[i]!) & 255;
      }
      async function sample(lane: string) {
        const start = performance.now();
        const value = await calls[lane]!(a, b);
        const elapsed = performance.now() - start;
        assert.ok(value instanceof Uint8Array);
        assert.equal(value.length, bytes);
        assert.ok(expected.equals(value));
        return elapsed;
      }
      for (const lane of lanes) for (let i = 0; i < warmup; i++) await sample(lane);
      const samples: Record<string, number[][]> = Object.fromEntries(lanes.map((lane) => [lane, []]));
      for (let r = 0; r < rounds; r++) {
        for (let j = 0; j < lanes.length; j++) {
          const lane = lanes[(j + r) % lanes.length]!;
          const timings: number[] = [];
          for (let i = 0; i < n; i++) timings.push(await sample(lane));
          samples[lane]!.push(timings);
        }
      }
      const rates: Record<string, number[]> = Object.fromEntries(lanes.map((lane) => [lane, []]));
      if (bytes === 2 || bytes === 65536) {
        for (let r = 0; r < rounds; r++)
          for (let j = 0; j < lanes.length; j++) {
            const lane = lanes[(j + r) % lanes.length]!;
            const start = performance.now();
            await Promise.all(Array.from({ length: 8 }, () => sample(lane)));
            rates[lane]!.push(8000 / (performance.now() - start));
          }
        perLaneCalls += 8 * rounds;
      }
      perLaneCalls += warmup + n * rounds;
      for (const lane of lanes) {
        const times = samples[lane]!.flat();
        const paired = samples[lane]!.map((t, r) => percentile(t, 50) / percentile(samples.off![r]!, 50));
        const sorted = paired.sort((a, b) => a - b);
        rows.push({
          lane,
          bytes,
          n: times.length,
          warmup,
          concurrency8CallsPerSecond: rates[lane],
          roundsMs: samples[lane],
          p50: percentile(times, 50),
          p95: percentile(times, 95),
          medianPairedRatioToOff: (sorted[2]! + sorted[3]!) / 2,
        });
      }
      console.log(
        runtime,
        bytes,
        rows
          .slice(-lanes.length)
          .map((x) => x.lane + ' ' + (x.p50 as number).toFixed(3) + 'ms')
          .join(', '),
      );
    }
    const python = JSON.parse(
      execFileSync('.venv/bin/python', ['scripts/add-python.py', url + '/off'], {
        encoding: 'utf8',
        timeout: 120000,
      }),
    );
    await Promise.all(clients.splice(0).map((sdk) => sdk.close()));
    child.stdin!.end();
    assert.equal(await exited, 0);
    const counts = JSON.parse(await readFile(resolve(dir, 'counts.json'), 'utf8'));
    assert.deepEqual(Object.values(counts), Array(4).fill(perLaneCalls));
    const events = (await readFile(resolve(dir, 'events.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.equal(events.length, perLaneCalls * 2);
    const phases = new Map<number, string>();
    for (const event of events) {
      assert.equal(event.tool, 'add');
      assert.equal(event.transport, 'http');
      if (event.phase === 'start') {
        assert.ok(!phases.has(event.id));
        phases.set(event.id, 'start');
      } else {
        assert.equal(event.phase, 'finish');
        assert.equal(event.status, 'ok');
        assert.equal(phases.get(event.id), 'start');
        phases.set(event.id, 'finish');
      }
    }
    for (let id = 1; id <= perLaneCalls; id++) assert.equal(phases.get(id), 'finish');
    const environment = {
      runtime,
      runtimeVersion: process.versions.bun ?? process.versions.node,
      cpu: cpus()[0]?.model,
      loadAverage: loadavg(),
      packageSha256: hashes[version],
      baselineSha256: hashes[previous],
      serverProcess: 'separate',
      mode: 'auto',
      serialConcurrency: 1,
      batchConcurrency: 8,
      bodyLimitBytes: 16 * 1024 * 1024,
    };
    await writeFile(
      'output/add-' + runtime + '.json',
      JSON.stringify({ environment, rounds, counts, fileEvents: events.length, rows, python }, null, 2) +
        '\n',
    );
  } finally {
    await Promise.allSettled(clients.map((sdk) => sdk.close()));
    if (child && child.exitCode === null) {
      child.stdin!.end();
      await exited;
    }
    await rm(dir, { recursive: true, force: true });
  }
}
if (process.argv[2] === '--serve') await serve(process.argv[3]!);
else await benchmark();
