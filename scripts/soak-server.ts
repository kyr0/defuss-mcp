/** VERIFIED: The soak fixture serves the installed package on the matrix's HTTP stacks and stdio, plus a heap tool that collects garbage before it measures. */
// It mounts the endpoints like examples/server.ts, without the RPC routes, so retained memory belongs to defuss-mcp
// and the MCP SDK. Forcing garbage collection is a diagnostic that only this loopback fixture exposes.
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { createMcpApi } from 'defuss-mcp';
import { createMcpHttp, type McpHttpEndpoint } from 'defuss-mcp/http';
import { serveMcpStdio } from 'defuss-mcp/stdio';
import { ExpressRpcServer } from 'defuss-rpc/express-server';

const bun = (globalThis as { Bun?: { gc(force: boolean): void } }).Bun;
// Node exposes gc only behind a flag, which a running process can still set.
let nodeGc: (() => void) | undefined;
if (!bun) {
  setFlagsFromString('--expose-gc');
  nodeGc = runInNewContext('gc') as () => void;
}
function heapUsed() {
  for (let i = 0; i < 3; i++) (bun ? () => bun.gc(true) : nodeGc!)();
  return process.memoryUsage().heapUsed;
}

const registry = createMcpApi(
  { name: 'defuss-mcp-soak', version: '1' },
  {
    directAdd(a: number, b: number) {
      return a + b;
    },
  },
);
const addition = {
  type: 'object' as const,
  properties: { a: { type: 'number' }, b: { type: 'number' } },
  required: ['a', 'b'],
  additionalProperties: false,
};
registry.json<{ a: number; b: number }>('add', addition, ({ a, b }) => a + b);
registry.binary('bytes.echo', (bytes) => bytes);
registry.json('heap', { type: 'object' }, heapUsed);

const providerName = process.argv[2] ?? 'express';
if (providerName === 'stdio') await serveMcpStdio(registry);
else {
  const endpoints = new Map<string, McpHttpEndpoint>();
  for (const mode of ['json', 'sse', 'auto'] as const)
    endpoints.set(
      '/mcp/' + mode,
      createMcpHttp(registry, { mode, authorize: (req) => req.headers.get('x-demo-key') === 'demo' }),
    );
  const options = { port: 0, host: '127.0.0.1' };
  let service: Pick<ExpressRpcServer, 'start' | 'stop'>;
  if (providerName === 'fetch') {
    const server = new ExpressRpcServer(options);
    server.getApp().fetch = (req) =>
      endpoints.get(new URL(req.url).pathname)?.fetch(req) ?? new Response(null, { status: 404 });
    service = server;
  } else {
    const provider =
      providerName === 'express'
        ? (await import('defuss-rpc/providers/express')).expressProvider()
        : (await import('defuss-rpc/providers/bunway')).bunwayProvider();
    const server = new ExpressRpcServer({ ...options, provider });
    for (const [path, endpoint] of endpoints) server.getApp().all(path, endpoint.middleware);
    service = server;
  }
  const { url } = await service.start();
  console.log(JSON.stringify({ time: new Date().toISOString(), level: 'info', message: 'listening', url }));
  process.once('SIGTERM', async () => {
    await Promise.all(Array.from(endpoints.values(), (endpoint) => endpoint.close()));
    await service.stop();
    process.exit(0);
  });
}
