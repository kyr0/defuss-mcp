/** VERIFIED: Real sockets and provider response objects exercise lifecycle paths bypassed by a Fetch-only client. */
import { it, expect } from 'vitest';
import { createServer, request } from 'node:http';
import { once } from 'node:events';
import { connect, type AddressInfo } from 'node:net';
import { createMcpApi } from '../src/index.js';
import { createMcpHttp } from '../src/http.js';
import { serveMcpStdio } from '../src/stdio.js';
import { nodeJsonHandler } from '../src/node-http.js';

const identity = { name: 'boundaries', version: '1' };
it('releases the child transport when the host closes its handle', async () => {
  const api = createMcpApi(identity);
  const handle = await serveMcpStdio(api);
  await handle.close();
  expect(() => api.json('late', { type: 'object' }, () => 1)).toThrow(/before/);
});
it('passes a denial and a bodyless response through the bunway middleware', async () => {
  const { BunRequest, BunResponse } = await import('bunway');
  const endpoint = createMcpHttp(createMcpApi(identity), {
    authorize: (req) =>
      req.headers.has('x-key')
        ? new Response(null, { status: 204 })
        : new Response('sign in', { status: 403, headers: { 'x-realm': 'tools' } }),
  });
  try {
    for (const auth of [false, true]) {
      const res = new BunResponse();
      const req = new Request('http://localhost/mcp', { headers: auth ? { 'x-key': 'demo' } : {} });
      await endpoint.middleware(new BunRequest(req), res);
      const actual = res.toResponse();
      expect(actual.status).toBe(auth ? 204 : 403);
      if (!auth) expect(actual.headers.get('x-realm')).toBe('tools');
      expect(await actual.text()).toBe(auth ? '' : 'sign in');
    }
  } finally {
    await endpoint.close();
  }
});
it('handles decoded chunks and BOM, empty responses, public size errors and private dispatch failures', async () => {
  const route = nodeJsonHandler(
    async (req) => {
      switch (new URL(req.url).pathname) {
        case '/headers':
          return Response.json({ cookies: req.headers.get('set-cookie') });
        case '/empty':
          return new Response(null, { status: 204 });
        case '/failure':
          throw Error('private detail');
        case '/broken':
          return new Response(
            new ReadableStream({
              start(c) {
                c.error(Error('unreadable'));
              },
            }),
            { headers: { 'content-type': 'application/json' } },
          );
        default:
          return Response.json({ text: await req.text() });
      }
    },
    48,
    new WeakSet(),
  );
  const server = createServer((req, res) => {
    req.setEncoding('utf8');
    void route(req, res);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
  try {
    expect(await (await fetch(base, { method: 'POST', body: '\uFEFFhello' })).json()).toEqual({
      text: 'hello',
    });
    expect((await fetch(base + '/empty')).status).toBe(204);
    const headers = await new Promise<string>((resolve, reject) => {
      const call = request(
        base + '/headers',
        { method: 'POST', headers: { 'set-cookie': ['a=1', 'b=2'] } },
        (res) => {
          let data = '';
          res.setEncoding('utf8');
          res.on('data', (part) => {
            data += part;
          });
          res.on('end', () => resolve(data));
          res.on('error', reject);
        },
      );
      call.on('error', reject);
      call.end('x');
    });
    expect(JSON.parse(headers).cookies).toBe('a=1, b=2');
    expect((await fetch(base, { method: 'POST', body: 'x'.repeat(49) })).status).toBe(413);
    const failed = await fetch(base + '/failure');
    expect(failed.status).toBe(500);
    expect(await failed.json()).toMatchObject({ error: { code: -32603, message: 'Internal server error' } });
    await expect(fetch(base + '/broken').then((r) => r.text())).rejects.toThrow();
  } finally {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  }
});
it('cancels a response allocated after the peer disconnects', async () => {
  const entered = Promise.withResolvers<void>(),
    cancelled = Promise.withResolvers<void>();
  const route = nodeJsonHandler(
    async (req) => {
      entered.resolve();
      await once(req.signal, 'abort');
      return new Response(
        new ReadableStream({
          cancel() {
            cancelled.resolve();
          },
        }),
      );
    },
    128,
    new WeakSet(),
  );
  const server = createServer((req, res) => {
    void route(req, res);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const client = request({
      host: '127.0.0.1',
      port: (server.address() as AddressInfo).port,
      method: 'POST',
    });
    client.on('error', () => {});
    client.end('ready');
    await entered.promise;
    client.destroy();
    await cancelled.promise;
  } finally {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  }
});
it('serves a raw Node listener in SSE and auto modes without a body parser', async () => {
  const { Client, StreamableHTTPClientTransport } = await import('@modelcontextprotocol/client');
  const api = createMcpApi(identity, {
    twice(n: number) {
      return n * 2;
    },
  });
  for (const mode of ['sse', 'auto'] as const) {
    const endpoint = createMcpHttp(api, { mode });
    const listener = createServer((req, res) => {
      void endpoint.middleware(req, res);
    });
    listener.listen(0, '127.0.0.1');
    await once(listener, 'listening');
    const url = new URL('http://127.0.0.1:' + (listener.address() as AddressInfo).port + '/mcp');
    const client = new Client(identity);
    try {
      await client.connect(new StreamableHTTPClientTransport(url));
      const reply = await client.callTool({ name: 'twice', arguments: { args: [21] } });
      expect(reply.structuredContent).toEqual({ value: 42 });
      const malformed = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: '{"jsonrpc":',
      });
      expect(malformed.status).toBe(400);
      expect((await malformed.json()).error.code).toBe(-32700);
    } finally {
      await client.close();
      await endpoint.close();
      listener.closeAllConnections();
      await new Promise<void>((resolve) => listener.close(() => resolve()));
    }
  }
});
it('reads a Request without a body stream, as Firefox constructs them', async () => {
  const endpoint = createMcpHttp(
    createMcpApi(identity, {
      add(a: number, b: number) {
        return a + b;
      },
    }),
    { mode: 'json', maxBodyBytes: 512 },
  );
  const post = (body: string) => {
    const request = new Request('http://localhost/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2026-07-28',
        'mcp-method': 'tools/call',
        'mcp-name': 'add',
      },
      body,
    });
    // VERIFIED (Playwright Firefox build 1538): Request.prototype.body is undefined there.
    Object.defineProperty(request, 'body', { value: undefined });
    return endpoint.fetch(request);
  };
  const meta = {
    'io.modelcontextprotocol/protocolVersion': '2026-07-28',
    'io.modelcontextprotocol/clientInfo': { name: 'firefox', version: '1' },
    'io.modelcontextprotocol/clientCapabilities': {},
  };
  const reply = await post(
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'add', arguments: { args: [2, 3] }, _meta: meta } }),
  );
  expect(reply.status).toBe(200);
  expect((await reply.json()).result.structuredContent).toEqual({ value: 5 });
  expect((await post(JSON.stringify({ pad: 'x'.repeat(600) }))).status).toBe(413);
  await endpoint.close();
});

it('answers an oversized upload with one JSON-RPC 413 that a client reads after sending its whole body', async () => {
  // VERIFIED: (probe, Python SDK 2.3.0) httpx writes the whole body before it reads, and a server that closed the
  // connection during the upload ended the client's session with a ReadError instead of this status.
  const limit = 64 * 1024,
    size = 4 * 1024 * 1024;
  const expected = {
    jsonrpc: '2.0',
    id: null,
    error: { code: -32000, message: 'Payload Too Large: Request body must not exceed 65536 bytes' },
  };
  for (const mode of ['json', 'sse', 'auto'] as const) {
    const endpoint = createMcpHttp(createMcpApi(identity), { mode, maxBodyBytes: limit });
    const listener = createServer((req, res) => void endpoint.middleware(req, res));
    listener.listen(0, '127.0.0.1');
    await once(listener, 'listening');
    const { port } = listener.address() as AddressInfo;
    try {
      const socket = connect(port, '127.0.0.1');
      await once(socket, 'connect');
      let reply = '';
      socket.on('data', (chunk) => (reply += chunk));
      const closed = once(socket, 'close');
      socket.write(
        `POST /mcp HTTP/1.1\r\nhost: 127.0.0.1:${port}\r\ncontent-type: application/json\r\n` +
          `accept: application/json, text/event-stream\r\ncontent-length: ${size}\r\n\r\n`,
      );
      await new Promise<void>((resolve, reject) =>
        socket.write(Buffer.alloc(size, 32), (error) => (error ? reject(error) : resolve())),
      );
      socket.end();
      await closed;
      expect(reply).toMatch(/^HTTP\/1\.1 413 /);
      expect(reply).not.toMatch(/^connection: close/im);
      expect(JSON.parse(/\{"jsonrpc".*\}/.exec(reply)![0])).toEqual(expected);
    } finally {
      listener.closeAllConnections();
      await new Promise<void>((resolve) => listener.close(() => resolve()));
      await endpoint.close();
    }
  }
  const endpoint = createMcpHttp(createMcpApi(identity), { maxBodyBytes: limit });
  const post = (body: BodyInit, headers: Record<string, string> = {}) =>
    endpoint.fetch(
      new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
        body,
        duplex: 'half',
      } as RequestInit),
    );
  const declared = await post('x'.repeat(limit + 1));
  const streamed = await post(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(limit + 1).fill(32));
        controller.close();
      },
    }),
  );
  for (const reply of [declared, streamed]) {
    expect(reply.status).toBe(413);
    expect(await reply.json()).toEqual(expected);
  }
  await endpoint.close();
});
