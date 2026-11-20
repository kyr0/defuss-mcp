import { describe, expect, it } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import {
  createMcp,
  createMcpApi,
  encodeBytes,
  decodeBytes,
  encodeDson,
  decodeDson,
  ToolFault,
} from '../src/index.js';
import { createMcpHttp } from '../src/http.js';
import { getMcpClient } from '../src/client.js';
import { collectionKey, bindingKey } from '../src/functions.js';
import { ajvValidator } from '../src/validation.js';
import { exposeRpc } from '../src/rpc.js';
import { createRpcServer, clearRpcServer, rpcRoute } from 'defuss-rpc/server';

const identity = { name: 'contract', version: '1' };
const schema = { type: 'object' as const };
type Http = ReturnType<typeof createMcpHttp>;

async function connected(
  http: Http,
  use: (client: Client, types: string[]) => Promise<void>,
  legacy = false,
  headers?: Record<string, string>,
) {
  const types: string[] = [];
  const client = new Client(identity, { versionNegotiation: { mode: legacy ? 'legacy' : 'auto' } });
  const transport = new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), {
    requestInit: { headers },
    fetch: async (url, init) => {
      const response = await http.fetch(new Request(url, init));
      types.push(response.headers.get('content-type') ?? '');
      return response;
    },
  });
  try {
    await client.connect(transport);
    await use(client, types);
  } finally {
    await client.close();
  }
}

describe('application contracts', () => {
  it('rejects invalid registrations, duplicate names and late registration', () => {
    const reg = createMcp(identity);
    expect(() => reg.json('bad name', schema, () => 0)).toThrow(/name/);
    expect(() => reg.json('x', schema, () => 0, { validate: true })).toThrow(/compiler/);
    reg.json('x', schema, () => 1);
    expect(() => reg.dson('x', () => 0)).toThrow(/Duplicate/);
    reg.factory();
    expect(() => reg.json('y', schema, () => 1)).toThrow(/before/);
    expect(() => createMcpHttp(reg, { maxBodyBytes: -1 })).toThrow(RangeError);
  });
  it('rolls back grouped registration on a late name collision', async () => {
    const r = createMcp(identity);
    r.json('duplicate', schema, () => 0);
    await expect(
      r.group((staged) => {
        staged.json('fresh', schema, () => 1);
        staged.dson('duplicate', (x) => x);
      }),
    ).rejects.toThrow(/Duplicate/);
    r.json('fresh', schema, () => 2);
    const http = createMcpHttp(r);
    await connected(http, async (client) =>
      expect((await client.callTool({ name: 'fresh', arguments: {} })).structuredContent).toEqual({
        value: 2,
      }),
    );
    await http.close();
  });
  it('compiles both dialects and reports escaped pointers and required values without coercion', () => {
    const compile = ajvValidator();
    const validate = compile({
      type: 'object',
      properties: { choice: { enum: ['a', 'b'] }, n: { const: 3 }, when: { type: 'string', format: 'date' } },
      required: ['a/b~'],
      additionalProperties: false,
    });
    const errors = validate({ choice: 'wrong', n: '3', when: 'never', extra: 2 });
    expect(errors?.map((x) => x.path).sort()).toEqual(['/a~1b~0', '/choice', '/extra', '/n', '/when']);
    const v7 = compile({
      type: 'object',
      $schema: 'http://json-schema.org/draft-07/schema#',
      properties: { n: { type: 'integer' } },
    });
    expect(v7({ n: 3 })).toBeUndefined();
    expect(v7({ n: '3' })).toHaveLength(1);
    expect(() => compile({ type: 'object', $async: true })).toThrow(/Async/);
  });
  it('preserves cyclic graphs, aliases, undefined and BigInt', () => {
    const x: { self?: unknown; value: bigint; absent?: unknown } = { value: 3n, absent: undefined };
    x.self = x;
    const y = decodeDson<typeof x>(encodeDson(x));
    expect(y.self).toBe(y);
    expect(y).toEqual(x);
  });
  it('never invokes invalid calls and reports handler faults without disclosing internal errors', async () => {
    let calls = 0;
    const errors: unknown[] = [];
    const reg = createMcp(identity, { compile: ajvValidator(), onError: (e) => errors.push(e) });
    reg.json('n', { type: 'object', required: ['x'] }, () => ++calls);
    reg.json('private', schema, () => {
      throw new Error('private-detail');
    });
    reg.json('public', schema, () => {
      throw new ToolFault('Try another key');
    });
    reg.dson('rich', (x) => x);
    const http = createMcpHttp(reg);
    await connected(http, async (client) => {
      const call = (name: string, args: Record<string, unknown> = {}) =>
        client.callTool({ name, arguments: args });
      expect((await call('n')).structuredContent).toMatchObject({ code: 'INVALID_ARGUMENTS' });
      expect(calls).toBe(0);
      expect((await call('n', { x: 1 })).structuredContent).toEqual({ value: 1 });
      expect((await call('private')).structuredContent).toEqual({ message: 'Tool execution failed.' });
      expect(errors.length).toBe(1);
      expect((await call('public')).structuredContent).toEqual({ message: 'Try another key' });
      expect((await call('rich', { foo: 1 })).isError).toBe(true);
      expect((await call('rich', { dson: '{' })).isError).toBe(true);
      await expect(call('unregistered')).rejects.toThrow(/Unknown tool/);
    });
    await http.close();
  });
});
describe('HTTP policy and framing', () => {
  it('checks host, exact origin, custom credentials and closed state', async () => {
    const http = createMcpHttp(createMcp(identity), {
      allowedHosts: ['test.local'],
      allowedOrigins: ['https://app.local'],
      authorize: (req) => req.headers.has('x-key'),
    });
    const status = async (url: string, headers: Record<string, string> = {}) =>
      (await http.fetch(new Request(url, { headers }))).status;
    expect(await status('http://localhost/')).toBe(403);
    expect(await status('http://test.local/', { host: 'other.local' })).toBe(403);
    expect(await status('http://test.local:8080/', { host: 'test.local:80' })).toBe(403);
    expect(await status('http://test.local/', { origin: 'null' })).toBe(403);
    expect(await status('http://test.local/', { origin: 'https://app.local' })).toBe(401);
    expect(await status('http://test.local/', { 'x-key': 'yes' })).toBe(405);
    await http.close();
    expect(await status('http://test.local/')).toBe(503);
    const custom = createMcpHttp(createMcp(identity), {
      authorize: () => new Response(null, { status: 403 }),
    });
    expect((await custom.fetch(new Request('http://localhost/'))).status).toBe(403);
    await custom.close();
  });
  it('delegates malformed JSON and unsupported media negotiation, and reports unreadable input', async () => {
    const http = createMcpHttp(createMcpApi(identity), { mode: 'json' });
    const request = (body: string, type: string) =>
      new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { 'content-type': type, accept: 'application/json, text/event-stream' },
        body,
      });
    try {
      const malformed = await http.fetch(request('{bad', 'application/json'));
      expect(malformed.status).toBe(400);
      expect((await malformed.json()).error.code).toBe(-32700);
      expect((await http.fetch(request('{}', 'text/plain'))).status).toBe(415);
      const broken = request('{}', 'application/json');
      await broken.text();
      expect((await http.fetch(broken)).status).toBe(400);
    } finally {
      await http.close();
    }
  });
  it('enforces byte limits, including chunked bodies, before dispatch', async () => {
    for (const mode of ['json', 'sse'] as const) {
      const http = createMcpHttp(createMcp(identity), { mode, maxBodyBytes: 64 });
      for (const declared of [true, false]) {
        const headers: Record<string, string> = { 'content-type': 'application/json' };
        if (declared) headers['content-length'] = '128';
        expect(
          (
            await http.fetch(
              new Request('http://localhost/', { method: 'POST', headers, body: ' '.repeat(128) }),
            )
          ).status,
        ).toBe(413);
      }
      await http.close();
    }
  });
  it.each(['auto', 'json', 'sse'] as const)(
    'delivers tool replies in %s mode in both protocol eras',
    async (mode) => {
      const registry = createMcp(identity);
      registry.json('identity', schema, (_args, ctx) => ctx.request?.headers.get('x-client'));
      const http = createMcpHttp(registry, { mode });
      await Promise.all(
        [true, false].map((legacy) =>
          connected(
            http,
            async (client, types) => {
              const res = await client.callTool({ name: 'identity', arguments: {} });
              expect(res.structuredContent).toEqual({ value: String(legacy) });
              const expected =
                mode === 'sse' || (legacy && mode === 'auto') ? 'text/event-stream' : 'application/json';
              expect(types.at(-1)).toContain(expected);
            },
            legacy,
            { 'x-client': String(legacy) },
          ),
        ),
      );
      await http.close();
    },
  );
  it('delivers progress while the handler is still waiting, and isolates simultaneous calls', async () => {
    const registry = createMcp(identity);
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    registry.json('work', schema, async (_input, ctx) => {
      await ctx.progress(1, 2, 'running');
      await wait;
      return ctx.request?.headers.get('x-tenant');
    });
    const http = createMcpHttp(registry, { mode: 'sse' });
    try {
      await connected(
        http,
        async (client) => {
          const result = await client.callTool(
            { name: 'work', arguments: {} },
            {
              onprogress: (p) => {
                expect(p.progress).toBe(1);
                release();
              },
              timeout: 1500,
            },
          );
          expect(result.structuredContent).toEqual({ value: 'one' });
        },
        false,
        { 'x-tenant': 'one' },
      );
    } finally {
      release();
      await http.close();
    }
  });
});
describe('official RPC dispatcher', () => {
  it('filters discovery and stops generators at the configured item limit', async () => {
    let closed = false;
    createRpcServer({
      Things: {
        hidden() {
          return 1;
        },
        *items() {
          try {
            yield 'α';
            yield 'β';
            yield 'γ';
          } finally {
            closed = true;
          }
        },
      },
    });
    try {
      const registry = createMcp(identity);
      await exposeRpc(registry, rpcRoute, {
        codec: 'json',
        maxStreamItems: 1,
        include: (_, m) => m === 'items',
      });
      const http = createMcpHttp(registry);
      await connected(http, async (client) => {
        expect((await client.listTools()).tools.map((t) => t.name)).toEqual(['Things.items']);
        const result = await client.callTool({ name: 'Things.items', arguments: { args: [] } });
        expect(result.structuredContent).toEqual({ message: 'RPC generator exceeded its item limit.' });
        expect(closed).toBe(true);
      });
      await http.close();
    } finally {
      await clearRpcServer();
    }
  });
});

describe('real mounting and cancellation', () => {
  it('consumes a pre-parsed Express JSON body and enforces the endpoint size limit', async () => {
    const { default: express } = await import('express');
    const { once } = await import('node:events');
    const app = express();
    const tools = createMcp(identity);
    tools.json('echo', schema, (value) => value);
    const endpoint = createMcpHttp(tools, { maxBodyBytes: 4096 });
    app.use(express.json({ limit: '32kb' }));
    app.all('/nested/mcp', endpoint.middleware);
    const server = app.listen(0, '127.0.0.1');
    const client = new Client(identity);
    try {
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Expected TCP listener.');
      const url = new URL('http://127.0.0.1:' + address.port + '/nested/mcp');
      await client.connect(new StreamableHTTPClientTransport(url));
      const result = await client.callTool({ name: 'echo', arguments: { parsed: true } });
      expect(result.structuredContent).toEqual({ value: { parsed: true } });
      expect(
        (
          await fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ x: 'z'.repeat(8192) }),
          })
        ).status,
      ).toBe(413);
    } finally {
      await client.close();
      await endpoint.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
  it('propagates an SSE client abort into the executing tool', async () => {
    const registry = createMcp(identity);
    let finish!: (value: string) => void;
    const observed = new Promise<string>((resolve) => {
      finish = resolve;
    });
    registry.observeCalls((event) => {
      if (event.phase === 'finish') finish(event.status);
    });
    let started!: () => void, stopped!: () => void;
    const entered = new Promise<void>((r) => {
      started = r;
    });
    const left = new Promise<void>((r) => {
      stopped = r;
    });
    registry.json('wait', schema, async (_, context) => {
      const done = new Promise<void>((resolve) =>
        context.signal.addEventListener(
          'abort',
          () => {
            stopped();
            resolve();
          },
          { once: true },
        ),
      );
      started();
      await done;
      return 'cancelled';
    });
    const endpoint = createMcpHttp(registry, { mode: 'sse' });
    try {
      await connected(endpoint, async (client) => {
        const abort = new AbortController();
        const pending = client.callTool({ name: 'wait', arguments: {} }, { signal: abort.signal });
        await entered;
        abort.abort();
        await expect(pending).rejects.toThrow();
        await left;
        expect(await observed).toBe('cancelled');
      });
    } finally {
      await endpoint.close();
    }
  }, 3000);
});

describe('direct function contracts', () => {
  it('preserves receivers, optional and rest parameters, rich graphs and stable object aliases', async () => {
    const source = {
      base: 10,
      add(x: number, ...rest: number[]) {
        return this.base + x + rest.reduce((n, v) => n + v, 0);
      },
      async mirror(x: unknown) {
        return x;
      },
      // oxlint-disable-next-line unicorn/no-thenable -- Verify an application method really can have this wire name.
      then() {
        return 12;
      },
      fail() {
        throw new ToolFault('Change the input.');
      },
    };
    const registry = createMcpApi(identity, source);
    registry.json('manual', schema, () => 0);
    const http = createMcpHttp(registry);
    try {
      await connected(http, async (sdk) => {
        const { tools } = await getMcpClient<typeof registry>(sdk);
        expect(Object.keys(tools).sort()).toEqual(['add', 'mirror', 'then', 'fail'].sort());
        expect(await tools.add(4, 1, 2)).toBe(17);
        expect(await tools.then()).toBe(12);
        const graph: Record<string, unknown> = { m: new Map([[2n, new Date(0)]]) };
        graph.self = graph;
        const copy = (await tools.mirror(graph)) as typeof graph;
        expect(copy.self).toBe(copy);
        expect(copy.m).toEqual(graph.m);
        await expect(tools.fail()).rejects.toThrow('Change the input.');
        for (const args of [
          { args: 3 },
          { args: [], dson: '{}' },
          { dson: 'broken' },
          encodeDson({ args: 'bad' }),
        ])
          expect((await sdk.callTool({ name: 'add', arguments: args })).isError).toBe(true);
        expect((await sdk.callTool({ name: 'add', arguments: { args: [2, 3] } })).structuredContent).toEqual({
          value: 15,
        });
      });
    } finally {
      await http.close();
    }
  });
  it('discovers array positions, collects generators, and preserves empty tuples', async () => {
    function* ticks(x: number) {
      yield x;
      return x + 1;
    }
    async function* asyncTicks(x: number) {
      yield x + 1;
      return x + 2;
    }
    const registry = createMcpApi(identity, [ticks, asyncTicks]);
    const http = createMcpHttp(registry);
    try {
      await connected(http, async (sdk) => {
        const { tools } = await getMcpClient<typeof registry>(sdk);
        expect(Array.isArray(tools)).toBe(true);
        expect(await tools[0](4)).toEqual({ items: [4], result: 5 });
        expect(await tools[1](4)).toEqual({ items: [5], result: 6 });
      });
    } finally {
      await http.close();
    }
    const empty = createMcpApi(identity, []);
    const emptyHttp = createMcpHttp(empty);
    try {
      await connected(emptyHttp, async (sdk) =>
        expect((await getMcpClient<typeof empty>(sdk)).tools).toEqual([]),
      );
    } finally {
      await emptyHttp.close();
    }
  });
  it('rejects ambiguous registrations without evaluating getters', () => {
    let reads = 0;
    expect(() =>
      createMcpApi(identity, {
        get accidental() {
          reads++;
          return () => 1;
        },
      }),
    ).toThrow(/data properties/);
    expect(reads).toBe(0);
    expect(() => createMcpApi(identity, [() => 1])).toThrow(/named/);
    function f() {
      return 1;
    }
    expect(() => createMcpApi(identity, [f, f])).toThrow(/Duplicate/);
    expect(() => createMcpApi(identity, new Date())).toThrow(/plain/);
    expect(() => createMcpApi(identity, Array(2))).toThrow(/named/);
    // Legacy options retain their original argument position.
    const old = createMcp(identity, { compile: ajvValidator() });
    expect(() => old.json('v', schema, () => 0, { validate: true })).not.toThrow();
    const renamed = createMcpApi(identity, { compile: ajvValidator() });
    expect(() => renamed.json('v', schema, () => 0, { validate: true })).not.toThrow();
    expect(() =>
      createMcpApi(identity, {
        get compile() {
          throw new Error('ran getter');
        },
      }),
    ).toThrow(/Invalid registry option/);
  });
  it('closes an over-limit generator and shields execution errors', async () => {
    let cleanups = 0;
    function* large() {
      try {
        yield 'x'.repeat(1024 * 1024);
      } finally {
        cleanups++;
      }
    }
    const api = createMcpApi(identity, { large });
    const http = createMcpHttp(api);
    try {
      await connected(http, async (sdk) => {
        const { tools } = await getMcpClient<typeof api>(sdk);
        await expect(tools.large()).rejects.toThrow('Tool execution failed.');
        expect(cleanups).toBe(1);
      });
    } finally {
      await http.close();
    }
  });
  it('checks discovery pages and rejects malformed tuple or result data', async () => {
    const tool = (name: string, key: unknown) => ({
      name,
      inputSchema: { type: 'object' as const },
      _meta: { [bindingKey]: key },
    });
    const fake = (pages: object[], result = { content: [], structuredContent: {} }) => ({
      async listTools() {
        return pages.shift()! as Awaited<ReturnType<Client['listTools']>>;
      },
      async callTool() {
        return result;
      },
    });
    const { tools } = await getMcpClient<ReturnType<typeof createMcpApi<{ x: () => number }>>>(
      fake([{ tools: [], nextCursor: 'next' }, { tools: [tool('x', 'x')] }]),
    );
    await expect(tools.x()).rejects.toThrow(/DSON/);
    await expect(
      getMcpClient(
        fake([
          { tools: [], nextCursor: 'x' },
          { tools: [], nextCursor: 'x' },
        ]),
      ),
    ).rejects.toThrow(/Repeated/);
    await expect(getMcpClient(fake([{ tools: [tool('a', 2)] }]))).rejects.toThrow(/Incomplete/);
    await expect(getMcpClient(fake([{ tools: [tool('a', 'b')] }]))).rejects.toThrow(/Invalid/);
    await expect(getMcpClient(fake([{ tools: [tool('a', 'a'), tool('b', 0)] }]))).rejects.toThrow(/Mixed/);
    await expect(getMcpClient(fake([{ tools: [], _meta: { [collectionKey]: 'string' } }]))).rejects.toThrow(
      /Inconsistent/,
    );
  });
  it('shares compiled identical schemas and keeps constraints and errors isolated', () => {
    const compile = ajvValidator(),
      spec = { type: 'object' as const, properties: { x: { const: 3 } } };
    const first = compile(spec);
    expect(compile(structuredClone(spec))).toBe(first);
    spec.properties.x.const = 4;
    const second = compile(spec);
    expect(second).not.toBe(first);
    expect(first({ x: 3 })).toBeUndefined();
    expect(second({ x: 3 })?.[0]?.expected).toEqual({ allowedValue: 4 });
    expect(first({ x: 4 })?.[0]?.expected).toEqual({ allowedValue: 3 });
  });
});

describe('binary tools and negotiated values', () => {
  it('strictly decodes canonical base64 to an isolated, exact-size store', () => {
    for (let n = 0; n < 256; n++) {
      const src = Uint8Array.from({ length: n + 5 }, (_, i) => (i * 37) & 255);
      const v = src.subarray(2, n + 2);
      const envelope = encodeBytes(v);
      expect(envelope.bytes).toBe(Buffer.from(v).toString('base64'));
      const out = decodeBytes(envelope);
      expect(out).toEqual(new Uint8Array(v));
      expect(out.buffer.byteLength).toBe(n);
    }
    for (const bytes of [
      'a',
      'A===',
      'AA=',
      'Zm9=',
      'AB==',
      'AA A',
      '_-==',
      '====',
      'Zm8=\n',
      '😄==',
      'AA==AAAA',
    ])
      expect(() => decodeBytes({ bytes })).toThrow();
    expect(() => decodeBytes({ bytes: 'AAAA', x: 1 })).toThrow();
    expect(() => decodeBytes({ bytes: 'AAAA' }, 2)).toThrow(RangeError);
    expect(() => encodeBytes(new Uint8Array(3), 2)).toThrow(RangeError);
    expect(() => decodeBytes({ bytes: '' }, -1)).toThrow(RangeError);
  });
  it('enforces binary tool limits on both sides of the handler', async () => {
    const api = createMcpApi(identity);
    let calls = 0;
    api.binary(
      'grow',
      (bytes) => {
        calls++;
        return new Uint8Array(bytes.byteLength + 1);
      },
      { maxBytes: 3 },
    );
    const http = createMcpHttp(api);
    try {
      await connected(http, async (sdk) => {
        const invoke = (args: Record<string, unknown>) => sdk.callTool({ name: 'grow', arguments: args });
        for (const arg of [{ bytes: 'AQIDBA==' }, { bytes: 'AB==' }, { bytes: '', extra: 1 }]) {
          const invalid = await invoke(arg);
          expect(invalid.structuredContent?.code).toBe('INVALID_BYTES');
        }
        expect(calls).toBe(0);
        expect(decodeBytes((await invoke({ bytes: 'AQI=' })).structuredContent)).toEqual(new Uint8Array(3));
        expect((await invoke({ bytes: 'AQID' })).isError).toBe(true);
        expect(() => api.binary('x', (x) => x, { maxBytes: NaN })).toThrow(RangeError);
      });
    } finally {
      await http.close();
    }
  });
  it('preserves binary types, signed zero, aliases and application keys through the SDK', async () => {
    const echo = (x: unknown) => x;
    const api = createMcpApi(identity, { echo, fetchFrame: (_when: Date) => Uint8Array.of(2, 5) });
    const http = createMcpHttp(api);
    try {
      await connected(http, async (sdk) => {
        const { tools } = await getMcpClient<typeof api>(sdk);
        expect(await tools.fetchFrame(new Date(0))).toEqual(Uint8Array.of(2, 5));
        const encoded = encodeDson({ args: [new Date(0)] });
        const modern = await sdk.callTool({
          name: 'fetchFrame',
          arguments: encoded,
          _meta: { 'org.defuss.mcp/compact-v1': true },
        });
        expect(modern.structuredContent).toEqual({ bytes: 'AgU=' });
        const previous = await sdk.callTool({ name: 'fetchFrame', arguments: encoded });
        expect(previous.structuredContent).toHaveProperty('dson');
        const slab = Buffer.allocUnsafe(30);
        slab.fill(0xfa);
        const view = slab.subarray(3, 8);
        view.fill(0x25);
        const floats = new Float32Array(new Uint32Array([0x7fc01234, 0x80000000]).buffer);
        const input = {
          frames: [view, new DataView(view.buffer, view.byteOffset, 2), floats],
          signed: new Int16Array([-2, 345]),
          wide: new BigInt64Array([-5n]),
          raw: Uint8Array.of(2, 3).buffer,
          bytes: { bytes: 'application' },
          ...JSON.parse('{"__proto__":{"safe":true}}'),
        };
        const back = (await tools.echo(input)) as typeof input;
        expect(Object.hasOwn(back, '__proto__')).toBe(true);
        expect(back.bytes).toEqual(input.bytes);
        expect(back.frames[0].buffer.byteLength).toBe(5);
        expect(back.frames[0]).toEqual(new Uint8Array(view));
        expect(back.frames[1]).toBeInstanceOf(DataView);
        expect(back.frames[1].byteLength).toBe(2);
        expect(Array.from(new Uint32Array(back.frames[2].buffer))).toEqual([0x7fc01234, 0x80000000]);
        expect(back.signed).toEqual(input.signed);
        expect(back.wide).toEqual(input.wide);
        expect(back.raw).toEqual(input.raw);
        const half = (
          globalThis as typeof globalThis & { Float16Array?: new (buffer: ArrayBuffer) => ArrayBufferView }
        ).Float16Array;
        if (half) {
          const bits = new Uint16Array([0x7e34, 0x8000, 0x3c00]);
          const restored = (await tools.echo(new half(bits.buffer))) as ArrayBufferView;
          expect(restored).toBeInstanceOf(half);
          expect(new Uint16Array(restored.buffer)).toEqual(bits);
        }
        const repeated = { bytes: view, also: view };
        const out = (await tools.echo(repeated)) as typeof repeated;
        expect(out.bytes).toBe(out.also);
        const root: { loop?: unknown } = {};
        root.loop = root;
        const cycle = (await tools.echo(root)) as typeof root;
        expect(cycle.loop).toBe(cycle);
        const malformed = (packed: unknown[]) => sdk.callTool({ name: 'echo', arguments: { packed } });
        for (const item of [
          { bytes: 'AQ==', kind: 'Float32Array' },
          { bytes: '', kind: 'other' },
          { record: false },
          { bytes: 'AA==', bad: 1 },
        ]) {
          expect((await malformed([item])).structuredContent?.code).toBe('INVALID_ARGUMENTS');
        }
      });
    } finally {
      await http.close();
    }
  });
  it('checks both schema dialects on each fresh registry and isolates application refs', () => {
    const spec = { type: 'object' as const, properties: { x: { type: 'integer' } } };
    for (const dialect of [
      'https://json-schema.org/draft/2020-12/schema',
      'http://json-schema.org/draft-07/schema#',
    ]) {
      const compile = ajvValidator();
      expect(() => compile({ ...spec, $schema: dialect, required: 42 } as never)).toThrow();
      expect(() => compile({ ...spec, $schema: dialect, pattern: '[' })).toThrow();
      expect(compile({ ...spec, $schema: dialect })({ x: 'bad' })).toHaveLength(1);
      expect(() => compile({ ...spec, $ref: 'https://example.invalid/other' })).toThrow();
    }
  });
});

describe('buffered Express JSON transport', () => {
  it('bounds a chunked POST on the socket, preserves auth body access and streams custom replies', async () => {
    const { createServer } = await import('node:http');
    const { once } = await import('node:events');
    let pushTail: () => void = () => {};
    const encoder = new TextEncoder();
    const endpoint = createMcpHttp(createMcpApi(identity), {
      mode: 'json',
      maxBodyBytes: 256,
      authorize: async (request) => {
        if (request.headers.has('x-stream')) {
          expect(await request.clone().text()).toBe('{"x":1}');
          return new Response(
            new ReadableStream({
              start(c) {
                c.enqueue(encoder.encode('{"a":'));
                pushTail = () => {
                  c.enqueue(encoder.encode('1}'));
                  c.close();
                };
              },
            }),
            { status: 403, headers: { 'content-type': 'application/json', 'x-test': 'stream' } },
          );
        }
        return true;
      },
    });
    const listener = createServer((req, res) => {
      void endpoint.middleware(req, res);
    });
    listener.listen(0, '127.0.0.1');
    await once(listener, 'listening');
    const address = listener.address();
    if (!address || typeof address === 'string') throw new Error('TCP required');
    const url = 'http://127.0.0.1:' + address.port + '/mcp';
    try {
      const data = new ReadableStream({
        start(c) {
          c.enqueue(encoder.encode('x'.repeat(150)));
          c.enqueue(encoder.encode('x'.repeat(140)));
          c.close();
        },
      });
      const tooLarge = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: data,
        duplex: 'half',
      } as RequestInit);
      expect(tooLarge.status).toBe(413);
      const response = await fetch(url, {
        method: 'POST',
        body: '{"x":1}',
        headers: { 'x-stream': '1', 'content-type': 'application/json' },
        signal: AbortSignal.timeout(4000),
      });
      expect(response.status).toBe(403);
      const reader = response.body!.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toBe('{"a":');
      pushTail();
      expect(new TextDecoder().decode((await reader.read()).value)).toBe('1}');
      await reader.cancel();
    } finally {
      await endpoint.close();
      listener.closeAllConnections();
      await new Promise<void>((resolve) => listener.close(() => resolve()));
    }
  });
});

describe('call observation and processing', () => {
  it('pairs concurrent calls and records rejected calls while isolating failing diagnostic sinks', async () => {
    const events: import('../src/index.js').CallEvent[] = [];
    let sinkFailures = 0;
    const api = createMcpApi(identity, { echo: (input: unknown) => input }).observeCalls(
      async (event) => {
        events.push(event);
        await Promise.resolve();
        throw Error('sink unavailable');
      },
      async () => {
        sinkFailures++;
        throw Error('fallback unavailable');
      },
    );
    api.json('private', schema, () => {
      throw Error('secret');
    });
    const http = createMcpHttp(api, { mode: 'sse' });
    try {
      expect(() => api.observeCalls(() => {})).toThrow(/before/);
      expect(() => api.processCalls({})).toThrow(/before/);
      await connected(http, async (client) => {
        const { tools } = await getMcpClient<typeof api>(client);
        expect(await Promise.all([tools.echo('red'), tools.echo('blue')])).toEqual(['red', 'blue']);
        expect((await client.callTool({ name: 'echo', arguments: {} })).isError).toBe(true);
        expect((await client.callTool({ name: 'private', arguments: {} })).isError).toBe(true);
        await expect(client.callTool({ name: 'missing', arguments: {} })).rejects.toThrow(/Unknown tool/);
      });
      expect(sinkFailures).toBe(10);
      expect(new Set(events.map((e) => e.id)).size).toBe(5);
      for (const start of events.filter((e) => e.phase === 'start')) {
        const pair = events.filter((e) => e.id === start.id);
        expect(pair.map((e) => e.phase)).toEqual(['start', 'finish']);
        expect(pair[1]).toMatchObject({ tool: start.tool, transport: 'http' });
      }
      const finishes = events.filter((e) => e.phase === 'finish');
      expect(finishes.filter((e) => e.status === 'error')).toHaveLength(3);
      expect(finishes.every((e) => e.durationMs >= 0)).toBe(true);
      expect(JSON.stringify(events)).not.toMatch(/red|blue|secret|Authorization/);
    } finally {
      await http.close();
    }
  });

  it('processes decoded values across direct, group, schema and byte registrations', async () => {
    const trace: string[] = [];
    const reg = createMcpApi(
      identity,
      { add: (a: Uint8Array, b: Uint8Array) => a.map((v, i) => v + b[i]!) },
      { compile: ajvValidator() },
    );
    reg.processCalls({
      async before(call, input) {
        trace.push('before ' + call.tool);
        if (call.kind === 'function') {
          const [a, b] = input as Uint8Array[];
          expect(a).toBeInstanceOf(Uint8Array);
          return { value: [a!.map((x) => x + 1), b] };
        }
        if (call.kind === 'json') return { value: { n: 'invalid' } };
        if (call.kind === 'binary') return { value: new Uint8Array(4) };
        expect(input).toBeInstanceOf(Date);
      },
      async after(call, output) {
        trace.push('after ' + call.tool);
        if (call.kind === 'function') return { value: (output as Uint8Array).map((x) => x * 2) };
        if (call.kind === 'dson') return { value: undefined };
      },
    });
    let ran = 0;
    reg.json(
      'number',
      { type: 'object', properties: { n: { type: 'integer' } }, required: ['n'] },
      () => ++ran,
    );
    reg.binary(
      'limited',
      (bytes) => {
        ran++;
        return bytes;
      },
      { maxBytes: 3 },
    );
    await reg.group((staged) => {
      staged.dson('graph', (v) => v);
    });
    await expect(
      reg.group(async (staged) => {
        staged.observeCalls(() => {});
      }),
    ).rejects.toThrow(/serving registry/);
    const http = createMcpHttp(reg);
    try {
      await connected(http, async (client) => {
        for (const codec of ['auto', 'dson'] as const) {
          const { tools } = await getMcpClient<typeof reg>(client, { codec });
          expect(await tools.add(new Uint8Array([1, 2]), new Uint8Array([3, 4]))).toEqual(
            new Uint8Array([10, 14]),
          );
        }
        expect(
          (await client.callTool({ name: 'number', arguments: { n: 1 } })).structuredContent,
        ).toMatchObject({ code: 'INVALID_ARGUMENTS' });
        expect(
          (await client.callTool({ name: 'limited', arguments: encodeBytes(new Uint8Array(1)) })).isError,
        ).toBe(true);
        expect(
          decodeDson(
            (await client.callTool({ name: 'graph', arguments: encodeDson(new Date(0)) })).structuredContent,
          ),
        ).toBeUndefined();
      });
      expect(ran).toBe(0);
      expect(trace).toEqual([
        'before add',
        'after add',
        'before add',
        'after add',
        'before number',
        'before limited',
        'before graph',
        'after graph',
      ]);
    } finally {
      await http.close();
    }
  });

  it('applies public and private error policy to processors and enforces output limits', async () => {
    const reg = createMcpApi(identity, { greet: () => 'hi' });
    let mode = 'tuple';
    reg.processCalls({
      before(call) {
        if (mode === 'tuple') return { value: {} };
        if (mode === 'public') throw new ToolFault('correct me');
        if (mode === 'private') throw Error('secret ' + call.tool);
      },
      after() {
        return { value: new Uint8Array(4) };
      },
    });
    reg.binary('byte', (x) => x, { maxBytes: 2 });
    const http = createMcpHttp(reg);
    try {
      await connected(http, async (client) => {
        for (const [m, message] of [
          ['tuple', 'argument array'],
          ['public', 'correct me'],
          ['private', 'execution failed'],
        ]) {
          mode = m!;
          const r = await client.callTool({ name: 'greet', arguments: { args: [] } });
          expect(r.isError).toBe(true);
          expect(r.structuredContent?.message).toContain(message);
        }
        mode = 'binary';
        const result = await client.callTool({ name: 'byte', arguments: encodeBytes(new Uint8Array([1])) });
        expect(result.structuredContent?.message).toContain('byte limit');
      });
    } finally {
      await http.close();
    }
  });
});

describe('generated named contracts', () => {
  it('rejects invalid wire input before a call and preserves typed arguments, return value, and tuple binding', async () => {
    const { bindContract } = await import('../src/index.js');
    let calls = 0;
    const bytes = { type: 'string' as const, contentEncoding: 'base64' as const };
    const add = bindContract(
      Object.freeze(function add(a: Uint8Array, b: Uint8Array) {
        calls++;
        return a.map((v, i) => v + b[i]!);
      }),
      {
        parameters: ['a', 'b'],
        description: 'Add bytes',
        inputSchema: {
          type: 'object',
          properties: { a: bytes, b: bytes },
          required: ['a', 'b'],
          additionalProperties: false,
        },
        outputSchema: {
          type: 'object',
          properties: { value: bytes },
          required: ['value'],
          additionalProperties: false,
        },
      },
    );
    const reg = createMcpApi(identity, [add] as const);
    const http = createMcpHttp(reg);
    try {
      await connected(http, async (client) => {
        const [tool] = (await client.listTools()).tools;
        expect(tool?.inputSchema.required).toEqual(['a', 'b']);
        for (const [args, path] of [
          [{ a: 'AQI=', b: '***=' }, '/b'],
          [{ a: 'AQI=' }, '/b'],
          [{ a: 'AQI=', b: 'AwQ=', extra: true }, '/extra'],
        ] as const) {
          const reply = await client.callTool({ name: 'add', arguments: args });
          expect(reply.structuredContent).toMatchObject({ code: 'INVALID_ARGUMENTS', issues: [{ path }] });
        }
        expect(calls).toBe(0);
        const reply = await client.callTool({ name: 'add', arguments: { a: 'AQI=', b: 'AwQ=' } });
        expect(reply.structuredContent).toEqual({ value: 'BAY=' });
        const { tools } = await getMcpClient<typeof reg>(client);
        expect(await tools[0](Uint8Array.of(1, 2), Uint8Array.of(3, 4))).toEqual(Uint8Array.of(4, 6));
        expect(calls).toBe(2);
      });
    } finally {
      await http.close();
    }
  });
  it('retains optional holes and rest, nested byte fields, nullable values and ordinary object prototypes', async () => {
    const { makeContractCodec } = await import('../src/contracts.js');
    const bytes = { type: 'string' as const, contentEncoding: 'base64' as const };
    const obj = {
      type: 'object' as const,
      properties: { frame: bytes, label: { type: ['string', 'null'] as const } },
      required: ['frame'],
      additionalProperties: false,
    };
    const contract = {
      parameters: ['options', 'limit', 'files'],
      rest: 'files',
      inputSchema: {
        type: 'object' as const,
        properties: {
          options: obj,
          limit: { type: 'number' as const },
          files: { type: 'array' as const, items: obj },
        },
        required: ['options'],
      },
      outputSchema: { type: 'object' as const, properties: { value: obj }, required: ['value'] },
    };
    const client = makeContractCodec(contract, 'client'),
      server = makeContractCodec(contract, 'server');
    const opt = { frame: Uint8Array.of(255), label: null };
    const wire = client.encodeArgs([opt, undefined, opt]);
    expect(wire).toEqual({
      options: { frame: '/w==', label: null },
      files: [{ frame: '/w==', label: null }],
    });
    const args = server.decodeArgs(wire);
    expect(args).toEqual([opt, undefined, opt]);
    expect(Object.getPrototypeOf(args[0])).toBe(Object.prototype);
    expect(server.decodeArgs({ options: { frame: '' } })).toHaveLength(1);
    expect(client.decodeResult(server.encodeResult(opt))).toEqual(opt);
    expect(() => server.decodeArgs({ options: { frame: '' }, files: [{ frame: '?' }] })).toThrow(
      '/files/0/frame',
    );
    expect(() => client.encodeResult(undefined)).toThrow('/value');
  });
  it('rechecks transformed arguments and protects callers from incorrect handler output', async () => {
    const n = { type: 'number' as const };
    const s = { type: 'object' as const, properties: { n }, required: ['n'], additionalProperties: false };
    let calls = 0;
    const reg = createMcpApi(identity, {}, { compile: ajvValidator() });
    reg.named(
      'count',
      {
        parameters: ['n'],
        inputSchema: s,
        outputSchema: { ...s, properties: { value: n }, required: ['value'] },
      },
      () => {
        calls++;
        return 'private';
      },
    );
    reg.processCalls({
      before(_, args) {
        if ((args as number[])[0] === 0) return { value: ['wrong'] };
      },
    });
    const http = createMcpHttp(reg);
    try {
      await connected(http, async (client) => {
        const a = await client.callTool({ name: 'count', arguments: { n: 0 } });
        expect(a.structuredContent).toMatchObject({ issues: [{ path: '/n' }] });
        expect(calls).toBe(0);
        const b = await client.callTool({ name: 'count', arguments: { n: 2 } });
        expect(b.isError).toBe(true);
        expect(b.structuredContent).toEqual({ message: 'Tool execution failed.' });
        expect(calls).toBe(1);
      });
    } finally {
      await http.close();
    }
  });
});

describe('RPC response boundaries', () => {
  it('keeps discovery atomic on rejected responses and malformed catalog entries', async () => {
    const registry = createMcpApi(identity);
    const ok = [{ moduleName: 'Things', methods: { one: { generator: false } } }];
    await expect(exposeRpc(registry, async () => new Response(null, { status: 503 }))).rejects.toThrow('503');
    await expect(exposeRpc(registry, async () => Response.json([...ok, { methods: {} }]))).rejects.toThrow(
      'namespace',
    );
    await expect(exposeRpc(registry, async () => Response.json(ok), { maxStreamBytes: 0 })).rejects.toThrow(
      'limit',
    );
    await exposeRpc(registry, async () => Response.json(ok));
    const http = createMcpHttp(registry);
    try {
      await connected(http, async (c) =>
        expect((await c.listTools()).tools.map((t) => t.name)).toEqual(['Things.one']),
      );
    } finally {
      await http.close();
    }
  });
  it('distinguishes RPC stream errors, empty bodies, truncation and size limits from a split valid return', async () => {
    const { DSON } = await import('defuss-dson');
    const registry = createMcpApi(identity);
    const methods = Object.fromEntries(
      ['empty', 'truncated', 'error', 'unknown', 'over', 'denied', 'ok'].map((key) => [
        key,
        { generator: true },
      ]),
    );
    const frame = (type: string, value?: unknown) => DSON.stringify({ type, value }) + '\n';
    await exposeRpc(
      registry,
      async ({ request }) => {
        if (request.method === 'GET') return Response.json([{ className: 'Flow', methods }]);
        const { methodName } = DSON.parse(await request.text());
        if (methodName === 'denied') return new Response('private denial', { status: 403 });
        if (methodName === 'empty') return new Response(null);
        const data =
          methodName === 'ok'
            ? frame('yield', 'ä') + frame('return', 'sum')
            : methodName === 'over'
              ? 'x'.repeat(2049)
              : methodName === 'truncated'
                ? frame('yield', 12)
                : frame(methodName);
        const bytes = new TextEncoder().encode(data);
        return new Response(
          new ReadableStream({
            start(ctrl) {
              for (const byte of bytes) ctrl.enqueue(Uint8Array.of(byte));
              ctrl.close();
            },
          }),
        );
      },
      { codec: 'json', maxStreamBytes: 2048 },
    );
    const http = createMcpHttp(registry);
    try {
      await connected(http, async (c) => {
        const call = (key: string, args: Record<string, unknown> = { args: [] }) =>
          c.callTool({ name: 'Flow.' + key, arguments: args });
        for (const [key, text] of Object.entries({
          empty: 'empty generator',
          truncated: 'before its return',
          error: 'generator failed',
          unknown: 'Unknown RPC generator frame',
          denied: '403',
          over: 'byte limit',
        })) {
          const r = await call(key);
          expect(r.isError).toBe(true);
          expect(r.structuredContent?.message).toContain(text);
        }
        expect((await call('ok', {})).structuredContent?.message).toContain('args array');
        expect((await call('ok')).structuredContent).toEqual({ value: { items: ['ä'], result: 'sum' } });
      });
    } finally {
      await http.close();
    }
  });
});

describe('validation and processor boundaries', () => {
  it.each(['before', 'after'] as const)(
    'runs a stand-alone %s processor on native values for every tool kind',
    async (phase) => {
      const reg = createMcpApi(identity, { one: (x: number) => x });
      reg.json('object', { type: 'object' }, (v) => v);
      reg.dson('rich', (v) => v);
      reg.binary('bytes', (v) => v);
      const seen: string[] = [];
      reg.processCalls({
        [phase]: (c: { tool: string }, v: unknown) => {
          seen.push(c.tool);
          return { value: v };
        },
      });
      const http = createMcpHttp(reg);
      try {
        await connected(http, async (client) => {
          for (const [name, args] of Object.entries({
            object: { n: 3 },
            rich: encodeDson(new Date(5)),
            bytes: encodeBytes(Uint8Array.of(9)),
            one: { args: [4] },
          })) {
            expect((await client.callTool({ name, arguments: args })).isError).toBeFalsy();
          }
          expect(seen).toEqual(['object', 'rich', 'bytes', 'one']);
        });
      } finally {
        await http.close();
      }
    },
  );
  it('enforces named constraints again after preprocessing, and routes output violations to private diagnostics', async () => {
    const n = { type: 'number' as const, maximum: 8 };
    const shape = (key: string) => ({ type: 'object' as const, properties: { [key]: n }, required: [key] });
    const errors: unknown[] = [];
    const reg = createMcpApi(
      identity,
      {},
      {
        compile: ajvValidator(),
        onError: (e) => {
          errors.push(e);
          throw Error('sink failed');
        },
      },
    );
    reg.named(
      'limited',
      { parameters: ['x'], inputSchema: shape('x'), outputSchema: shape('value') },
      ([x]) => (x === 4 ? 20 : x),
    );
    let invoked = 0;
    reg.processCalls({
      before(_, raw) {
        const [x] = raw as number[];
        if (x === 1) return { value: 'invalid' };
        if (x === 2) return { value: [99] };
        if (x === 3) throw Error('private processor error');
      },
      after(_, v) {
        invoked++;
        return { value: v };
      },
    });
    const http = createMcpHttp(reg);
    try {
      await connected(http, async (c) => {
        const call = (x: number) => c.callTool({ name: 'limited', arguments: { x } });
        expect((await call(1)).structuredContent?.message).toContain('argument array');
        expect((await call(2)).structuredContent).toMatchObject({
          issues: [{ path: '/x', keyword: 'maximum' }],
        });
        expect((await call(3)).structuredContent).toEqual({ message: 'Tool execution failed.' });
        expect((await call(4)).structuredContent).toEqual({ message: 'Tool execution failed.' });
        expect((await call(5)).structuredContent).toEqual({ value: 5 });
        expect(invoked).toBe(2);
        expect(errors).toHaveLength(2);
      });
      await expect(reg.group(() => {})).rejects.toThrow(/before/);
      expect(() => createMcpApi(identity).json('x', { type: 'array' } as never, () => 1)).toThrow(
        /object root/,
      );
    } finally {
      await http.close();
    }
  });
  it('cancels a pending upstream generator read when a legacy JSON request is aborted', async () => {
    const start = Promise.withResolvers<void>(),
      stop = Promise.withResolvers<void>();
    const reg = createMcpApi(identity);
    // Start is signalled by pull with a zero high-water mark, after collectStream has installed its abort listener.
    await exposeRpc(
      reg,
      async ({ request }) =>
        request.method === 'GET'
          ? Response.json([{ moduleName: 'Items', methods: { read: { generator: true } } }])
          : new Response(
              new ReadableStream(
                {
                  pull() {
                    start.resolve();
                  },
                  cancel() {
                    stop.resolve();
                  },
                },
                { highWaterMark: 0 },
              ),
            ),
      { codec: 'json' },
    );
    const endpoint = createMcpHttp(reg, { mode: 'json' });
    const abort = new AbortController();
    const frame = {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'Items.read', arguments: { args: [] } },
    };
    try {
      const response = endpoint
        .fetch(
          new Request('http://localhost/mcp', {
            method: 'POST',
            signal: abort.signal,
            body: JSON.stringify(frame),
            headers: {
              'content-type': 'application/json',
              accept: 'application/json, text/event-stream',
              'mcp-protocol-version': '2025-11-25',
            },
          }),
        )
        .catch((e) => e);
      await start.promise;
      abort.abort();
      const [reason] = await Promise.all([response, stop.promise]);
      expect(reason).toBe(abort.signal.reason);
    } finally {
      abort.abort();
      await endpoint.close();
    }
  }, 4000);
});

it('mixes named and positional methods in a partial RPC contract catalog', async () => {
  const NumberTools = { twice: (x: number) => 2 * x, constant: () => 3 };
  createRpcServer({ NumberTools, Other: { single: () => 1 } });
  const reg = createMcpApi(identity, {}, { compile: ajvValidator() });
  const n = { type: 'number' as const };
  try {
    await exposeRpc(reg, rpcRoute, {
      codec: 'json',
      contracts: {
        NumberTools: {
          twice: {
            parameters: ['x'],
            inputSchema: { type: 'object', properties: { x: n }, required: ['x'] },
            outputSchema: { type: 'object', properties: { value: n }, required: ['value'] },
          },
        },
      },
    });
    const endpoint = createMcpHttp(reg);
    try {
      await connected(endpoint, async (c) => {
        const call = (name: string, args: Record<string, unknown>) => c.callTool({ name, arguments: args });
        expect((await call('NumberTools.twice', { x: 4 })).structuredContent).toEqual({ value: 8 });
        expect((await call('NumberTools.twice', { x: false })).structuredContent).toMatchObject({
          issues: [{ path: '/x' }],
        });
        expect((await call('NumberTools.constant', { args: [] })).structuredContent).toEqual({ value: 3 });
        expect((await call('Other.single', { args: [] })).structuredContent).toEqual({ value: 1 });
      });
    } finally {
      await endpoint.close();
    }
  } finally {
    await clearRpcServer();
  }
});

it('uses canonical default ports and enforces the same-origin policy when Origin is supplied', async () => {
  const endpoint = createMcpHttp(createMcpApi(identity), {
    authorize: () => new Response(null, { status: 204 }),
  });
  try {
    for (const [url, host] of [
      ['https://localhost/', 'localhost:443'],
      ['http://localhost/', 'localhost:80'],
    ]) {
      const ask = (origin: string) => endpoint.fetch(new Request(url!, { headers: { host: host!, origin } }));
      expect((await ask(new URL(url!).origin)).status).toBe(204);
      expect((await ask('https://other.local')).status).toBe(403);
    }
  } finally {
    await endpoint.close();
  }
});

it('preserves root correction paths for JSON and named schemas and permits a per-tool opt-out', async () => {
  const reg = createMcpApi(identity, {}, { compile: ajvValidator() });
  const constrained = {
    type: 'object' as const,
    maxProperties: 0,
    properties: { unused: { type: 'boolean' as const } },
  };
  reg.json('strict', constrained, () => 1);
  reg.json('unchecked', constrained, () => 2, { validate: false });
  reg.named(
    'named',
    {
      parameters: ['unused'],
      inputSchema: constrained,
      outputSchema: { type: 'object', properties: { value: { type: 'number' } } },
    },
    () => 3,
  );
  reg.binary('broken', () => 42 as never);
  const endpoint = createMcpHttp(reg);
  try {
    await connected(endpoint, async (c) => {
      for (const name of ['named', 'strict']) {
        const r = await c.callTool({ name, arguments: { unused: true } });
        expect(r.structuredContent?.message).toContain('(root)');
        expect(r.structuredContent).toMatchObject({ issues: [{ path: '', keyword: 'maxProperties' }] });
      }
      expect(
        (await c.callTool({ name: 'unchecked', arguments: { unused: true } })).structuredContent,
      ).toEqual({ value: 2 });
      expect(
        (await c.callTool({ name: 'broken', arguments: { bytes: '' } })).structuredContent?.message,
      ).toBe('Tool execution failed.');
    });
  } finally {
    await endpoint.close();
  }
});
