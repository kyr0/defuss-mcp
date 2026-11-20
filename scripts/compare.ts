/** VERIFIED: Alternate two packed releases on the same Express listener and validate each timed result. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { cpus, loadavg, platform, arch } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { once } from 'node:events';
import express from 'express';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { CallToolResult } from '@modelcontextprotocol/client';
import { median } from './stats.ts';

// Both extracted releases load at runtime, so this driver states the surface it uses from each.
interface Registry {
  json(name: string, schema: object, handler: (input: { data: string; n: number }) => unknown): Registry;
  factory(): unknown;
}
interface Release {
  createMcp(identity: object, functions?: object, options?: object): Registry;
  ajvValidator(): unknown;
  getMcpClient(client: Client): Promise<{ tools: Record<string, (value: unknown) => Promise<unknown>> }>;
}
type Endpoint = { middleware(req: unknown, res: unknown): Promise<void>; close(): Promise<void> };

const identity = { name: 'compare', version: '1' };
const current: string = JSON.parse(readFileSync('package.json', 'utf8')).version;
const runtime = process.versions.bun ? 'bun' : 'node';
const sha = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
const versions = ['0.4.0', current] as const;
const rounds = 8,
  calls = 60,
  warmup = 40;
mkdirSync('tmp', { recursive: true });
mkdirSync('output', { recursive: true });
const dir = mkdtempSync(resolve('tmp', 'compare-'));
const app = express();
const handles: Endpoint[] = [],
  clients: Client[] = [],
  libraries: Release[] = [],
  rows: Record<string, unknown>[] = [],
  hashes: Record<string, string> = {};
let listener: Server | undefined;
type Timings = number[][][];
function summarize(label: string, timings: Timings, extra = {}) {
  const medians = timings.map((samples) => samples.map(median));
  const ratio = medians[1]!.map((m, i) => m / medians[0]![i]!);
  const ms = medians.map(median);
  console.log(
    label,
    ...ms.map((m) => m.toFixed(3) + 'ms'),
    'paired change',
    ((median(ratio) - 1) * 100).toFixed(1) + '%',
  );
  rows.push({
    label,
    ...extra,
    roundsMs: timings,
    medianRoundP50Ms: ms,
    medianPairedChangePercent: 100 * (median(ratio) - 1),
    candidateFasterRounds: ratio.filter((r) => r < 1).length,
  });
}
try {
  execFileSync('bun', ['pm', 'pack', '--destination', dir], { stdio: 'pipe' });
  for (const [n, version] of versions.entries()) {
    const archive = n
      ? resolve(dir, 'defuss-mcp-' + current + '.tgz')
      : resolve('vendor/baseline/defuss-mcp-0.4.0.tgz');
    hashes[version] = sha(archive);
    if (n === 0)
      assert.equal(hashes[version], 'cfce4106c75ec977b38c2d1ec4b48c3e1eaf537c61ce5acc93248ecd65b70193');
    const target = resolve(dir, version);
    mkdirSync(target);
    execFileSync('tar', ['-xzf', archive, '--strip-components=1', '-C', target]);
    const load = (name: string) => import(pathToFileURL(resolve(target, 'dist', name + '.mjs')).href);
    const [entry, { createMcpHttp }, { ajvValidator }, { getMcpClient }] = await Promise.all(
      ['index', 'http', 'validation', 'client'].map(load),
    );
    const createMcp = entry.createMcpApi ?? entry.createMcp;
    libraries.push({ createMcp, ajvValidator, getMcpClient });
    const api = createMcp(
      identity,
      {
        echo(value: unknown) {
          return value;
        },
      },
      { compile: ajvValidator() },
    );
    api.json(
      'size',
      { type: 'object', properties: { data: { type: 'string' } }, required: ['data'] },
      ({ data }: { data: string }) => data.length,
    );
    const endpoint: Endpoint = createMcpHttp(api, {
      mode: 'json',
      authorize: (req: Request) => req.headers.get('x-bench') === '1',
    });
    handles.push(endpoint);
    app.all('/' + version, endpoint.middleware);
  }
  listener = app.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const port = (listener.address() as AddressInfo).port;
  for (const era of ['auto', 'legacy'] as const) {
    const pair: Client[] = [],
      measurements: { active: boolean; requestBytes: number; replyBytes: number }[] = [];
    for (const version of versions) {
      const client = new Client(identity, { versionNegotiation: { mode: era } });
      clients.push(client);
      const measure = { active: false, requestBytes: 0, replyBytes: 0 };
      measurements.push(measure);
      await client.connect(
        new StreamableHTTPClientTransport(new URL('http://127.0.0.1:' + port + '/' + version), {
          requestInit: { headers: { 'x-bench': '1' } },
          fetch: async (url, init) => {
            if (!measure.active) return fetch(url, init);
            const req = new Request(url, init);
            measure.requestBytes = (await req.clone().arrayBuffer()).byteLength;
            const res = await fetch(req);
            measure.replyBytes = (await res.clone().arrayBuffer()).byteLength;
            return res;
          },
        }),
      );
      pair.push(client);
    }
    for (let peer = 0; peer < 2; peer++) {
      const cross = await libraries[1 - peer]!.getMcpClient(pair[peer]!);
      const view = Uint8Array.of(1, 2, 255);
      assert.deepEqual(await cross.tools.echo!(view), view);
    }
    for (const bytes of [16, 65536]) {
      const request = { name: 'size', arguments: { data: 'x'.repeat(bytes) } };
      async function sample(client: Client, count: number) {
        const timings: number[] = [];
        for (let i = 0; i < count; i++) {
          const start = performance.now();
          const result = (await client.callTool(request)) as CallToolResult;
          timings.push(performance.now() - start);
          assert.deepEqual(result.structuredContent, { value: bytes });
        }
        return timings;
      }
      for (const c of pair) await sample(c, warmup);
      const times: Timings = [[], []];
      for (let r = 0; r < rounds; r++)
        for (const n of r % 2 ? [1, 0] : [0, 1]) times[n]!.push(await sample(pair[n]!, calls));
      summarize(era + ' JSON, ' + bytes + ' ASCII payload bytes', times);
    }
    const facades = await Promise.all(pair.map((client, i) => libraries[i]!.getMcpClient(client)));
    for (const [bytes, perRound, nested] of [
      [256, 16, false],
      [4096, 12, false],
      [65536, 6, false],
      [65536, 6, true],
      [1048576, 2, false],
    ] as const) {
      const payload = Uint8Array.from({ length: bytes }, (_, i) => (i * 37 + 11) & 255);
      const expected = Buffer.from(payload.buffer);
      const input = nested ? { name: 'frame', channels: [{ data: payload }] } : payload;
      async function sample(index: number, count: number) {
        const elapsed: number[] = [];
        for (let i = 0; i < count; i++) {
          const start = performance.now(),
            value = await facades[index]!.tools.echo!(input);
          elapsed.push(performance.now() - start);
          const frame = value as { name: string; channels: { data: unknown }[] };
          if (nested) assert.equal(frame.name, 'frame');
          const output = nested ? frame.channels[0]!.data : value;
          assert.ok(output instanceof Uint8Array);
          assert.ok(expected.equals(output));
        }
        return elapsed;
      }
      const wire: { requestBytes: number; replyBytes: number }[] = [];
      for (let index = 0; index < 2; index++) {
        measurements[index]!.active = true;
        await sample(index, 1);
        measurements[index]!.active = false;
        const { requestBytes, replyBytes } = measurements[index]!;
        wire.push({ requestBytes, replyBytes });
        await sample(index, 2);
      }
      const times: Timings = [[], []];
      for (let r = 0; r < rounds; r++)
        for (const index of r % 2 ? [1, 0] : [0, 1]) times[index]!.push(await sample(index, perRound));
      summarize(era + ' typed ' + (nested ? 'nested ' : '') + 'binary echo, ' + bytes + ' bytes', times, {
        bytes,
        perRound,
        nested,
        wire,
      });
    }
  }
  // Build the complete registry and SDK factory. Reuse one or 64 distinct trusted contracts.
  function register(lib: Release, unique: boolean) {
    const r = lib.createMcp(identity, { compile: lib.ajvValidator() });
    for (let i = 0; i < 64; i++)
      r.json(
        'tool' + i,
        { type: 'object', properties: { n: { type: 'integer', maximum: unique ? i : 64 } }, required: ['n'] },
        (obj) => obj.n,
      );
    r.factory();
  }
  for (const unique of [false, true]) {
    for (const lib of libraries) register(lib, unique);
    const times: Timings = [[], []];
    for (let r = 0; r < rounds; r++)
      for (const n of r % 2 ? [1, 0] : [0, 1]) {
        const measured: number[] = [];
        for (let i = 0; i < 3; i++) {
          const start = performance.now();
          register(libraries[n]!, unique);
          measured.push(performance.now() - start);
        }
        times[n]!.push(measured);
      }
    summarize('Register 64 tools, ' + (unique ? '64 schemas' : 'one schema'), times);
  }
  for (const unique of [false, true]) {
    const times: Timings = [[], []];
    for (let r = 0; r < rounds; r++)
      for (const n of r % 2 ? [1, 0] : [0, 1]) {
        const target = resolve(dir, versions[n]!, 'dist');
        const code = [
          'import {createMcpApi} from ' + JSON.stringify(pathToFileURL(resolve(target, 'index.mjs')).href),
          'import {ajvValidator} from ' +
            JSON.stringify(pathToFileURL(resolve(target, 'validation.mjs')).href),
          "const start=performance.now(), api=createMcpApi({name:'cold',version:'1'},{compile:ajvValidator()})",
          "for(let i=0;i<64;i++) api.json('tool'+i,{type:'object',properties:{n:{type:'integer',maximum:" +
            (unique ? 'i' : '64') +
            "}},required:['n']},x=>x.n)",
          'api.factory()',
          'console.log(performance.now()-start)',
        ].join(';');
        const args = runtime === 'bun' ? ['-e', code] : ['--input-type=module', '-e', code];
        const time = Number(execFileSync(process.execPath, args, { encoding: 'utf8' }).trim());
        assert.ok(Number.isFinite(time));
        times[n]!.push([time]);
      }
    summarize('First registry in fresh process, ' + (unique ? '64 schemas' : 'one schema'), times);
  }
  // A Fetch host (Bun.serve, a Worker) imports the HTTP entry without mounting Node middleware.
  const importTimes: Timings = [[], []];
  for (let r = 0; r < rounds; r++)
    for (const n of r % 2 ? [1, 0] : [0, 1]) {
      const target = resolve(dir, versions[n]!, 'dist');
      const code = [
        'const start=performance.now()',
        'await import(' + JSON.stringify(pathToFileURL(resolve(target, 'index.mjs')).href) + ')',
        'await import(' + JSON.stringify(pathToFileURL(resolve(target, 'http.mjs')).href) + ')',
        'console.log(performance.now()-start)',
      ].join(';');
      const args = runtime === 'bun' ? ['-e', code] : ['--input-type=module', '-e', code];
      const time = Number(execFileSync(process.execPath, args, { encoding: 'utf8' }).trim());
      assert.ok(Number.isFinite(time));
      importTimes[n]!.push([time]);
    }
  summarize('Import index and http entries in fresh process', importTimes);
  writeFileSync(
    'output/compare-' + runtime + '.json',
    JSON.stringify({
      environment: {
        runtime,
        versions: process.versions,
        os: platform(),
        arch: arch(),
        cpu: cpus()[0]?.model,
        loadAverage: loadavg(),
        packageSha256: hashes[current],
        hashes,
        measuredAt: new Date().toISOString(),
      },
      versions,
      rounds,
      serialCallsPerHttpRound: calls,
      warmupCallsPerHttpEndpoint: warmup,
      rows,
    }),
  );
} finally {
  for (const client of clients) await client.close();
  for (const h of handles) await h.close();
  if (listener) await new Promise<void>((ok, fail) => listener!.close((err) => (err ? fail(err) : ok())));
  rmSync(dir, { recursive: true, force: true });
}
