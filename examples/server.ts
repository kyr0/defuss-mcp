/** VERIFIED: The provider app hosts both RPC and MCP on one loopback listener. Stdio uses the same catalog. */
// The same API and listener serve all benchmark clients.
import { add as byteAdd, contracts } from './math.mcp.ts';
import { createMcpApi, encodeBytes } from 'defuss-mcp';
import { createMcpHttp, type McpHttpEndpoint } from 'defuss-mcp/http';
import { serveMcpStdio } from 'defuss-mcp/stdio';
import { ajvValidator } from 'defuss-mcp/validation';
import { exposeRpc } from 'defuss-mcp/rpc';
import { createRpcServer, rpcRoute, addHook } from 'defuss-rpc/server';
import { ExpressRpcServer } from 'defuss-rpc/express-server';

export const Arithmetic = {
  add(a: number, b: number) {
    return a + b;
  },
  echo<T>(value: T) {
    return value;
  },
  guarded() {
    return 'authorized';
  },
  *steps() {
    yield 'first';
    yield 'second';
    return 'done';
  },
};
class Counter {
  count = 0;
  increment() {
    return ++this.count;
  }
}
createRpcServer({ Arithmetic, Counter, math: { add: byteAdd } });
addHook({
  phase: 'guard',
  fn: (ns, method, _args, req) => (method !== 'guarded' && ns !== 'math') || req.headers.get('x-scope') === 'read',
});

const registry = createMcpApi(
  { name: 'defuss-mcp-example', version: '0.6.1' },
  { directAdd: Arithmetic.add, directEcho: Arithmetic.echo, byteAdd },
  { compile: ajvValidator() },
);
const addition = {
  type: 'object' as const,
  properties: { a: { type: 'number' }, b: { type: 'number' } },
  required: ['a', 'b'],
  additionalProperties: false,
};
registry.json<{ a: number; b: number }>('add', addition, ({ a, b }) => Arithmetic.add(a, b), {
  description: 'Add two numbers.',
});
registry.binary('bytes.echo', (bytes) => bytes);
/** Bytes `(i * 37 + 11) mod 256`, which a client can regenerate to check a download. */
function pattern(size: number) {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i++) bytes[i] = (i * 37 + 11) & 255;
  return bytes;
}
// A download is bounded by the binary codec's 16 MiB default, not by the HTTP request limit.
registry.json<{ size: number }>(
  'bytes.pattern',
  {
    type: 'object',
    properties: { size: { type: 'integer', minimum: 0, maximum: 16 * 1024 * 1024 } },
    required: ['size'],
    additionalProperties: false,
  },
  ({ size }) => encodeBytes(pattern(size)),
  { description: 'Return size bytes of a repeating pattern.', annotations: { readOnlyHint: true } },
);
registry.dson('echo', (value) => value, { description: 'Return a DSON graph.' });
registry.json('unchecked', addition, (input) => input, { validate: false });
registry.json('progress', { type: 'object' }, async (_, ctx) => {
  await ctx.progress(1, 2, 'started');
  await new Promise((resolve) => setTimeout(resolve, 12));
  await ctx.progress(2, 2, 'finished');
  return 'done';
});
await exposeRpc(registry, rpcRoute, { contracts: { math: contracts } });
await exposeRpc(registry, rpcRoute, { codec: 'json', prefix: 'json.' });

const providerName = process.argv[2] ?? 'express';
if (providerName === 'stdio') {
  // stdout carries the protocol, so the reason for a closed connection, such as an oversized message, goes to stderr.
  await serveMcpStdio(registry, {
    onerror: (error) =>
      console.error(JSON.stringify({ time: new Date().toISOString(), level: 'error', message: error.message })),
  });
} else {
  const endpoints = new Map<string, McpHttpEndpoint>();
  for (const mode of ['json', 'sse', 'auto'] as const)
    // Fixed demonstration credential for loopback integration tests only.
    endpoints.set(
      '/mcp/' + mode,
      createMcpHttp(registry, { mode, authorize: (req) => req.headers.get('x-demo-key') === 'demo' }),
    );
  const options = { port: Number(process.argv[3] ?? 0), host: '127.0.0.1' };
  let service: Pick<ExpressRpcServer, 'start' | 'stop'>;
  if (providerName === 'express' || providerName === 'bunway') {
    // bunway is a Bun-only module, so each provider loads on demand.
    const provider =
      providerName === 'express'
        ? (await import('defuss-rpc/providers/express')).expressProvider()
        : (await import('defuss-rpc/providers/bunway')).bunwayProvider();
    const server = new ExpressRpcServer({ ...options, provider });
    for (const [path, endpoint] of endpoints) server.getApp().all(path, endpoint.middleware);
    service = server;
  } else if (providerName === 'fetch') {
    // Without a provider, defuss-rpc serves Bun.serve and forwards unmatched requests to this handler.
    const server = new ExpressRpcServer(options);
    server.getApp().fetch = (req) =>
      endpoints.get(new URL(req.url).pathname)?.fetch(req) ?? new Response(null, { status: 404 });
    service = server;
  } else throw new Error('Choose stdio, express, bunway or fetch, not ' + providerName);
  const { url } = await service.start();
  console.log(JSON.stringify({ time: new Date().toISOString(), level: 'info', message: 'listening', url }));
  const stop = async () => {
    await Promise.all(Array.from(endpoints.values(), (endpoint) => endpoint.close()));
    await service.stop();
    process.exit(0);
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}
