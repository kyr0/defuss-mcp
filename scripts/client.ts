/** VERIFIED: The TypeScript SDK calls the packed server over real transports and records received progress separately from callback delivery. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { basename } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { CallToolResult, JSONRPCMessage } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { getRpcClient, setHeaders } from 'defuss-rpc/client';
import { getMcpClient } from 'defuss-mcp/client';
import { encodeDson, decodeDson, encodeBytes, decodeBytes } from 'defuss-mcp';
import type { McpApi } from 'defuss-mcp';

// The server owns the real signatures. These shapes are what this driver relies on.
type Api = McpApi<{
  directAdd(a: number, b: number): number;
  directEcho(value: unknown): unknown;
  byteAdd(a: Uint8Array, b: Uint8Array): Uint8Array;
}>;
type Rpc = {
  Arithmetic: {
    add(a: number, b: number): Promise<number>;
    echo(value: Uint8Array): Promise<Uint8Array>;
    guarded(): Promise<string>;
  };
};
type Mode = 'json' | 'sse' | 'auto' | 'stdio';
type Era = 'auto' | 'legacy';

const [action, target, serverRuntime] = process.argv.slice(2) as [string, string, string];
const headers = { 'x-demo-key': 'demo', 'x-scope': 'read' };
const stdio = target === 'stdio';
const runtime = process.versions.bun ? 'bun' : 'node';

function transport(mode: Mode, script = 'server.ts') {
  return stdio
    ? new StdioClientTransport({ command: serverRuntime, args: [script, 'stdio'], stderr: 'inherit' })
    : new StreamableHTTPClientTransport(new URL(target + '/mcp/' + mode), { requestInit: { headers } });
}
async function withClient<T>(mode: Mode, era: Era, run: (client: Client) => Promise<T>) {
  const client = new Client(
    { name: 'defuss-client-test', version: '0.3.0' },
    { versionNegotiation: { mode: era } },
  );
  try {
    await client.connect(transport(mode));
    return await run(client);
  } finally {
    await client.close();
  }
}
const call = (
  client: Client,
  name: string,
  args: Record<string, unknown>,
  options?: Parameters<Client['callTool']>[1],
) => client.callTool({ name, arguments: args }, options) as Promise<CallToolResult>;
function structured(result: CallToolResult) {
  return result.structuredContent as Record<string, unknown>;
}
function value(result: CallToolResult) {
  assert.ok(!result.isError, JSON.stringify(result));
  return structured(result).value;
}
const modes: Mode[] = stdio ? ['stdio'] : ['json', 'sse', 'auto'];
const MiB = 1024 * 1024;
/** The example server's bytes.pattern content: byte i is (i * 37 + 11) mod 256. */
function pattern(size: number) {
  const bytes = Buffer.allocUnsafe(size);
  for (let i = 0; i < size; i++) bytes[i] = (i * 37 + 11) & 255;
  return bytes;
}
// An upload just under the 4 MiB HTTP request limit, or over stdio under the SDK's 10 MiB read buffer. An HTTP
// download has no request limit; 11 MiB stays under the Inspector's 16 MiB SSE line once base64 enlarges it.
const UPLOAD = stdio ? 6 * MiB : 3 * MiB - 4096;
const DOWNLOAD = stdio ? 6 * MiB : 11 * MiB;
/**
 * Compare the lowest retained heap of the first and the last third of the rounds, at least 22,500 calls apart.
 * Garbage collection noise only lifts the heap above its floor; a leak raises the floor. VERIFIED: (probes, 108,000 and
 * 135,000 calls) Node's old space after forced collection moved between plateaus up to 3.4 MiB apart without a trend,
 * while Bun's heap stayed within 0.1 MiB. So a server on Node fails above 6 MiB, which a leak of about 280 bytes per
 * call reaches, and on Bun above 1 MiB, about 47 bytes per call. Two batches of sixteen 1 MiB echoes must not retain
 * half a batch.
 */
function soakVerdict(heapBytes: number[], largeHeapBytes: number[], serverOnBun: boolean) {
  const third = Math.floor(heapBytes.length / 3);
  const growthBytes = Math.min(...heapBytes.slice(-third)) - Math.min(...heapBytes.slice(0, third));
  const largeGrowthBytes = largeHeapBytes[1]! - largeHeapBytes[0]!;
  const limitBytes = serverOnBun ? MiB : 6 * MiB;
  return { growthBytes, limitBytes, largeGrowthBytes, bounded: growthBytes < limitBytes && largeGrowthBytes < 8 * MiB };
}
const reports: Record<string, unknown>[] = [];
if (action === 'test') {
  if (stdio) {
    const sdk = new Client({ name: 'stdio-logging', version: '1' });
    // Node strips types only outside node_modules, so the matrix copies the example next to this driver.
    const child = new StdioClientTransport({
      command: serverRuntime,
      args: ['observed-stdio.ts'],
      stderr: 'pipe',
    });
    let log = '';
    child.stderr!.on('data', (chunk: Buffer) => {
      log += chunk.toString();
    });
    try {
      await sdk.connect(child);
      const { tools } = await getMcpClient<McpApi<{ add(a: Uint8Array, b: Uint8Array): Uint8Array }>>(sdk);
      assert.deepEqual(await tools.add(new Uint8Array([1, 2]), new Uint8Array([3, 4])), new Uint8Array([4, 6]));
    } finally {
      await sdk.close();
    }
    const events = log
      .trim()
      .split('\n')
      .filter((line) => line.startsWith('{"time":'))
      .map((line) => JSON.parse(line));
    assert.deepEqual(
      events.map((e) => [e.transport, e.tool, e.phase, e.status]),
      [
        ['stdio', 'add', 'start', undefined],
        ['stdio', 'add', 'finish', 'ok'],
      ],
    );
    assert.equal(events[0].id, events[1].id);
    // A message over the server's 10 MiB stdio buffer closes the connection; onerror reports why on stderr.
    const oversized = new StdioClientTransport({ command: serverRuntime, args: ['server.ts', 'stdio'], stderr: 'pipe' });
    let diagnostics = '';
    oversized.stderr!.on('data', (chunk: Buffer) => (diagnostics += chunk));
    const big = new Client({ name: 'stdio-oversized', version: '1' });
    try {
      await big.connect(oversized);
      await assert.rejects(call(big, 'bytes.echo', encodeBytes(pattern(8 * MiB))));
    } finally {
      await big.close();
    }
    const failure = diagnostics.split('\n').find((line) => line.startsWith('{"time":'));
    assert.match(failure ?? diagnostics, /"level":"error".*10485760/);
  }
  for (const era of ['auto', 'legacy'] as const)
    for (const mode of modes) {
      await withClient(mode, era, async (client) => {
        const names = (await client.listTools()).tools.map((t) => t.name);
        for (const name of ['add', 'Arithmetic.echo', 'json.Counter.increment'])
          assert.ok(names.includes(name));
        assert.equal(value(await call(client, 'add', { a: 4, b: 7 })), 11);
        const bad = await call(client, 'add', { a: 'four', extra: true });
        assert.equal(bad.isError, true);
        const issues = structured(bad).issues as { path: string }[];
        assert.deepEqual(issues.map((i) => i.path).sort(), ['/a', '/b', '/extra']);
        assert.equal(value(await call(client, 'add', { a: 4, b: 2 })), 6);
        assert.deepEqual(value(await call(client, 'unchecked', { x: 1 })), { x: 1 });
        const graph: Record<string, unknown> = {
          when: new Date(0),
          big: 2n ** 72n,
          map: new Map([['x', new Set([1])]]),
          bytes: new Uint8Array([3, 7]),
        };
        graph.self = graph;
        const { tools } = await getMcpClient<Api>(client);
        assert.equal(await tools.directAdd(4, 7), 11);
        assert.deepEqual(
          await tools.byteAdd(new Uint8Array([1, 2]), new Uint8Array([3, 4])),
          new Uint8Array([4, 6]),
        );
        const view = Buffer.allocUnsafe(8194).subarray(1, 8193);
        for (let i = 0; i < view.length; i++) view[i] = (i * 37 + 3) & 255;
        const publicBytes = await call(client, 'bytes.echo', encodeBytes(view));
        assert.ok(view.equals(decodeBytes(publicBytes.structuredContent)));
        const nested = (await tools.directEcho({ file: 'f', frames: [{ data: view }] })) as {
          frames: { data: Uint8Array }[];
        };
        assert.ok(view.equals(nested.frames[0]!.data));
        const direct = (await tools.directEcho(graph)) as typeof graph;
        assert.equal(direct.self, direct);
        assert.deepEqual(direct, graph);
        for (const [name, arg] of [
          ['echo', graph],
          ['Arithmetic.echo', { args: [graph] }],
        ] as const) {
          const back = decodeDson<typeof graph>((await call(client, name, encodeDson(arg))).structuredContent);
          assert.equal(back.self, back);
          assert.deepEqual(back, graph);
        }
        assert.equal((await call(client, 'echo', { dson: 'not-json' })).isError, true);
        for (let i = 0; i < 2; i++)
          assert.equal(value(await call(client, 'json.Counter.increment', { args: [] })), 1);
        assert.deepEqual(value(await call(client, 'json.Arithmetic.steps', { args: [] })), {
          items: ['first', 'second'],
          result: 'done',
        });
        const up = pattern(UPLOAD);
        assert.ok(up.equals(decodeBytes((await call(client, 'bytes.echo', encodeBytes(up))).structuredContent)));
        const down = value(await call(client, 'bytes.pattern', { size: DOWNLOAD }));
        assert.ok(pattern(DOWNLOAD).equals(decodeBytes(down)));
        const frame = pattern(2 * MiB).subarray(1);
        assert.ok(frame.equals((await tools.directEcho(frame)) as Uint8Array));
        if (!stdio) {
          await assert.rejects(
            call(client, 'bytes.echo', encodeBytes(pattern(3 * MiB))),
            /Request body must not exceed 4194304 bytes/,
          );
          assert.equal(value(await call(client, 'add', { a: 1, b: 2 })), 3);
        }
        const guarded = await call(client, 'json.Arithmetic.guarded', { args: [] });
        if (stdio) assert.equal(guarded.isError, true);
        else assert.equal(value(guarded), 'authorized');
        const updates: number[] = [],
          frames: number[] = [];
        // Observe the official transport before the SDK schedules its callbacks.
        const active = client.transport!;
        const original = active.onmessage!;
        if (stdio)
          active.onmessage = (message: JSONRPCMessage, extra) => {
            if ('method' in message && message.method === 'notifications/progress')
              frames.push((message.params as { progress: number }).progress);
            original(message, extra);
          };
        const result = await call(client, 'progress', {}, { onprogress: (p) => updates.push(p.progress) });
        assert.equal(value(result), 'done');
        if (stdio) {
          assert.deepEqual(frames, [1, 2]);
          assert.ok(updates.length === 2 || updates.length === 1);
          assert.deepEqual(updates, [1, 2].slice(0, updates.length));
          active.onmessage = original;
        } else assert.deepEqual(updates, mode === 'json' ? [] : [1, 2]);
        reports.push({
          client: runtime,
          mode,
          era,
          progressCallbacks: updates,
          ...(stdio ? { progressFrames: frames } : {}),
        });
      });
    }
  if (!stdio) {
    const denied = await fetch(target + '/mcp/json', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(denied.status, 401);
    assert.equal(denied.headers.get('www-authenticate'), 'Bearer');
    const wrongOrigin = await fetch(target + '/mcp/json', {
      method: 'POST',
      headers: { ...headers, origin: 'https://other.invalid', 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(wrongOrigin.status, 403);
    const restricted = new Client({ name: 'restricted', version: '1' });
    try {
      await restricted.connect(
        new StreamableHTTPClientTransport(new URL(target + '/mcp/json'), {
          requestInit: { headers: { 'x-demo-key': 'demo' } },
        }),
      );
      const rejected = await call(restricted, 'json.Arithmetic.guarded', { args: [] });
      assert.ok(rejected.isError);
      assert.match((rejected.content[0] as { text: string }).text, /403/);
    } finally {
      await restricted.close();
    }
    setHeaders(headers);
    const rpc = await getRpcClient<Rpc>({ baseUrl: target });
    assert.equal(await rpc.Arithmetic.add(4, 7), 11);
    assert.equal(await rpc.Arithmetic.guarded(), 'authorized');
  }
} else if (action === 'soak') {
  // Retained heap after forced collection, sampled between equal rounds of calls. A per-request leak grows it with
  // every round, while caches and pools fill during the first one.
  const rounds = 12,
    perRound = 1500,
    small = encodeBytes(new Uint8Array(1024).fill(7)),
    large = encodeBytes(new Uint8Array(1024 * 1024).fill(9));
  // Automatic mode answers with one of these two reply paths.
  for (const mode of stdio ? (['stdio'] as const) : (['json', 'sse'] as const)) {
    const client = new Client({ name: 'soak', version: '1' });
    try {
      await client.connect(transport(mode, 'soak-server.ts'));
      const { tools } = await getMcpClient<McpApi<{ directAdd(a: number, b: number): number }>>(client);
      const heap = async () => value(await call(client, 'heap', {})) as number;
      const round = async () => {
        for (let i = 0; i < perRound; i++) {
          assert.equal(value(await call(client, 'add', { a: i, b: 1 })), i + 1);
          assert.equal(await tools.directAdd(i, 2), i + 2);
          assert.ok(!(await call(client, 'bytes.echo', small)).isError);
        }
      };
      await round();
      const heapBytes: number[] = [];
      for (let r = 0; r < rounds; r++) {
        await round();
        heapBytes.push(await heap());
      }
      const largeHeapBytes: number[] = [];
      for (let r = 0; r < 2; r++) {
        for (let i = 0; i < 16; i++) assert.ok(!(await call(client, 'bytes.echo', large)).isError);
        largeHeapBytes.push(await heap());
      }
      const verdict = soakVerdict(heapBytes, largeHeapBytes, basename(serverRuntime).startsWith('bun'));
      reports.push({ client: runtime, mode, callsPerRound: perRound * 3, heapBytes, largeHeapBytes, ...verdict });
      assert.ok(verdict.bounded, `retained heap grew over ${mode}: ${JSON.stringify(verdict)}`);
    } finally {
      await client.close();
    }
  }
} else if (action === 'large') {
  // Uploads echo back, so they move twice their size. The server's resident set is sampled every 20 ms with ps,
  // which also runs on Linux; a sample can miss a peak shorter than that.
  const rssBytes = (pid: number) =>
    new Promise<number>((resolve) =>
      execFile('ps', ['-o', 'rss=', '-p', String(pid)], (error, out) => resolve(error ? 0 : Number(out.trim()) * 1024)),
    );
  for (const mode of stdio ? (['stdio'] as const) : (['json', 'sse'] as const)) {
    const client = new Client({ name: 'large', version: '1' });
    const wire = transport(mode);
    try {
      await client.connect(wire);
      const pid = wire instanceof StdioClientTransport ? wire.pid! : Number(process.argv[5]);
      for (const [method, bytes] of [
        ['upload', MiB],
        ['upload', UPLOAD],
        ['download', MiB],
        ['download', DOWNLOAD],
      ] as const) {
        const expected = pattern(bytes),
          payload = encodeBytes(expected);
        const once = async () => {
          const t = performance.now();
          const received =
            method === 'upload'
              ? decodeBytes((await call(client, 'bytes.echo', payload)).structuredContent)
              : decodeBytes(value(await call(client, 'bytes.pattern', { size: bytes })));
          const ms = performance.now() - t;
          assert.ok(expected.equals(received));
          return ms;
        };
        for (let i = 0; i < 2; i++) await once();
        const serverRssBeforeBytes = await rssBytes(pid);
        let serverRssPeakBytes = serverRssBeforeBytes,
          sampling = true;
        const sampler = (async () => {
          while (sampling) {
            serverRssPeakBytes = Math.max(serverRssPeakBytes, await rssBytes(pid));
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
        })();
        const samplesMs: number[] = [];
        for (let i = 0; i < 10; i++) samplesMs.push(await once());
        sampling = false;
        await sampler;
        const movedBytes = method === 'upload' ? 2 * bytes : bytes;
        reports.push({ client: runtime, mode, method, bytes, movedBytes, samplesMs, serverRssBeforeBytes, serverRssPeakBytes });
      }
    } finally {
      await client.close();
    }
  }
} else if (action === 'binary') {
  const run = async (mode: string, method: string, invoke: (bytes: Buffer) => Promise<unknown>) => {
    for (const bytes of [4096, 65536]) {
      const payload = Buffer.from(Uint8Array.from({ length: bytes }, (_, i) => (i * 37 + 11) & 255));
      const samplesMs: number[] = [],
        concurrency8CallsPerSecond: number[] = [];
      async function checked() {
        const t = performance.now();
        const output = await invoke(payload);
        const duration = performance.now() - t;
        assert.ok(output instanceof Uint8Array && payload.equals(output));
        return duration;
      }
      for (let i = 0; i < 3; i++) await checked();
      for (let round = 0; round < 3; round++) {
        for (let i = 0; i < 8; i++) samplesMs.push(await checked());
        const start = performance.now();
        await Promise.all(Array.from({ length: 8 }, checked));
        concurrency8CallsPerSecond.push(8000 / (performance.now() - start));
      }
      reports.push({ client: runtime, mode, method, bytes, samplesMs, concurrency8CallsPerSecond });
    }
  };
  if (!stdio) {
    setHeaders(headers);
    const rpc = await getRpcClient<Rpc>({ baseUrl: target });
    await run('http', 'rpc-dson', (b) => rpc.Arithmetic.echo(b));
  }
  for (const mode of stdio ? (['stdio'] as const) : (['json', 'sse'] as const))
    await withClient(mode, 'auto', async (client) => {
      const compact = await getMcpClient<Api>(client),
        original = await getMcpClient<Api>(client, { codec: 'dson' });
      await run(mode, 'mcp-bytes', async (b) =>
        decodeBytes((await call(client, 'bytes.echo', encodeBytes(b))).structuredContent),
      );
      await run(mode, 'mcp-functions-auto', (b) => compact.tools.directEcho(b));
      await run(mode, 'mcp-functions-dson', (b) => original.tools.directEcho(b));
    });
} else {
  // Keep every client open. Rotate scenarios so JIT warmup and fixed ordering
  // cannot systematically favor the last method in the comparison.
  interface Scenario {
    mode: string;
    method: string;
    invoke: (i: number) => Promise<unknown>;
    samplesMs: number[];
    callsPerSecond: number[];
    concurrency8CallsPerSecond: number[];
  }
  const scenarios: Scenario[] = [],
    clients: Client[] = [];
  const rounds = 5,
    calls = 100,
    warmup = 80;
  function scenario(mode: string, method: string, invoke: Scenario['invoke']) {
    scenarios.push({ mode, method, invoke, samplesMs: [], callsPerSecond: [], concurrency8CallsPerSecond: [] });
  }
  try {
    if (!stdio) {
      setHeaders(headers);
      const rpc = await getRpcClient<Rpc>({ baseUrl: target });
      scenario('http', 'rpc', (i) => rpc.Arithmetic.add(i, 1));
    }
    for (const mode of stdio ? (['stdio'] as const) : (['json', 'sse'] as const)) {
      const client = new Client({ name: 'bench', version: '1' });
      clients.push(client);
      await client.connect(transport(mode));
      scenario(mode, 'mcp', async (i) => value(await call(client, 'add', { a: i, b: 1 })));
      const bound = await getMcpClient<Api>(client);
      scenario(mode, 'mcp-functions-json', async (i) =>
        value(await call(client, 'directAdd', { args: [i, 1] })),
      );
      const oldCodec = await getMcpClient<Api>(client, { codec: 'dson' });
      scenario(mode, 'mcp-functions-dson', (i) => oldCodec.tools.directAdd(i, 1));
      scenario(mode, 'mcp-functions-auto', (i) => bound.tools.directAdd(i, 1));
      scenario(mode, 'mcp-rpc-bridge', async (i) =>
        value(await call(client, 'json.Arithmetic.add', { args: [i, 1] })),
      );
    }
    for (const row of scenarios) for (let i = 0; i < warmup; i++) assert.equal(await row.invoke(i), i + 1);
    for (let round = 0; round < rounds; round++) {
      for (let step = 0; step < scenarios.length; step++) {
        const row = scenarios[(round + step) % scenarios.length]!;
        let start = performance.now();
        for (let i = 0; i < calls; i++) {
          const t = performance.now(),
            result = await row.invoke(i);
          row.samplesMs.push(performance.now() - t);
          assert.equal(result, i + 1);
        }
        row.callsPerSecond.push((calls * 1000) / (performance.now() - start));
        start = performance.now();
        for (let batch = 0; batch < 12; batch++)
          await Promise.all(
            Array.from({ length: 8 }, async (_, lane) => {
              const i = batch * 8 + lane;
              assert.equal(await row.invoke(i), i + 1);
            }),
          );
        row.concurrency8CallsPerSecond.push(96000 / (performance.now() - start));
      }
    }
    for (const { invoke: _invoke, ...row } of scenarios)
      reports.push({ client: runtime, warmup, calls, rounds, ...row });
  } finally {
    await Promise.all(clients.map((client) => client.close()));
  }
}
console.log(JSON.stringify(reports));
