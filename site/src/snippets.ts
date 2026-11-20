// VERIFIED: (test/build.test.ts) Code shown on the page and in llms.txt. Shiki highlights these at build time
// (build/highlight.ts); llms.txt pulls them by id, so both stay in step.
import type { Snippet } from '../build/highlight.ts';

const install = (command: string): Snippet => ({ lang: 'shellscript', prefix: '$', code: command });

export const snippets = {
  'install-bun': install('bun add defuss-mcp'),
  'install-npm': install('npm install defuss-mcp'),
  'install-pnpm': install('pnpm add defuss-mcp'),
  'install-yarn': install('yarn add defuss-mcp'),
  hero: {
    lang: 'typescript',
    code: `import { createMcpApi } from 'defuss-mcp';
import { createMcpHttp } from 'defuss-mcp/http';

const identity = { name: 'greeter', version: '1.0.0' };
const functions = { greet: (name: string) => 'Hello, ' + name };

export const api = createMcpApi(identity, functions, {
  metadata: { greet: { annotations: { readOnlyHint: true } } },
});
const endpoint = createMcpHttp(api);
Bun.serve({ port: 3000, fetch: (req) => endpoint.fetch(req) });`,
  },
  fetch: {
    lang: 'typescript',
    code: `// server.ts, run with: bun server.ts
import { createMcpApi } from 'defuss-mcp';
import { createMcpHttp } from 'defuss-mcp/http';

export const api = createMcpApi(
  { name: 'greeter', version: '1.0.0' },
  { greet(name: string) { return 'Hello, ' + name; } },
  { metadata: { greet: { title: 'Greet', annotations: { readOnlyHint: true } } } },
);
const endpoint = createMcpHttp(api);
Bun.serve({ hostname: '127.0.0.1', port: 3000, fetch: (request) => endpoint.fetch(request) });

// client.ts: the official SDK client with typed functions
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { getMcpClient } from 'defuss-mcp/client';
import type { api } from './server.ts';

const sdk = new Client({ name: 'caller', version: '1.0.0' });
await sdk.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:3000/mcp')));
const { tools } = await getMcpClient<typeof api>(sdk);
console.log(await tools.greet('Ada')); // "Hello, Ada", typed as string`,
  },
  express: {
    lang: 'typescript',
    code: `import express from 'express';
import { createMcpApi } from 'defuss-mcp';
import { createMcpHttp } from 'defuss-mcp/http';
import { ajvValidator } from 'defuss-mcp/validation';

const tools = createMcpApi({ name: 'arithmetic', version: '1.0.0' }, { compile: ajvValidator() });
tools.json<{ a: number; b: number }>('add', {
  type: 'object',
  properties: { a: { type: 'number' }, b: { type: 'number' } },
  required: ['a', 'b'],
  additionalProperties: false,
}, ({ a, b }) => a + b, { description: 'Add two numbers.', annotations: { readOnlyHint: true } });

const token = process.env.MCP_API_TOKEN;
if (!token) throw new Error('Set MCP_API_TOKEN before starting the server.');
const endpoint = createMcpHttp(tools, {
  authorize: (request) => request.headers.get('authorization') === 'Bearer ' + token,
});
const app = express();
app.all('/mcp', endpoint.middleware);
app.listen(3000, '127.0.0.1');`,
  },
  stdio: {
    lang: 'typescript',
    code: `import { createMcpApi } from 'defuss-mcp';
import { serveMcpStdio } from 'defuss-mcp/stdio';

const notes = ['Ship the release', 'Review the client matrix'];
const api = createMcpApi({ name: 'notes', version: '1.0.0' }, {
  search(query: string, limit = 10) { return notes.filter((note) => note.includes(query)).slice(0, limit); },
});
api.observeCalls((event) => {
  process.stderr.write(JSON.stringify({ time: new Date().toISOString(), level: 'info', ...event }) + '\\n');
});
const handle = await serveMcpStdio(api);
process.once('SIGTERM', () => void handle.close());`,
  },
  contracts: install('bunx defuss-mcp --entry src/math.ts --out src/math.mcp.ts'),
  'contract-source': {
    lang: 'typescript',
    code: `// math.ts
/** Add equal-length byte arrays elementwise, modulo 256. */
export function add(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length !== b.length) throw new RangeError('Expected equal lengths.');
  return a.map((value, i) => value + b[i]!);
}

// server.ts: a stock client now sees { a: base64, b: base64 } and gets corrections at /a or /b
import { createMcpApi } from 'defuss-mcp';
import { add } from './math.mcp.js';
export const api = createMcpApi({ name: 'math', version: '1' }, { add });`,
  },
  typed: {
    lang: 'typescript',
    code: `const { tools } = await getMcpClient<typeof api>(sdk);
await tools.add(2, 3);                                   // 5
await tools.byteAdd(Uint8Array.of(1, 2), Uint8Array.of(3, 4)); // Uint8Array [4, 6]
await tools.tally(['mcp', 'dson', 'mcp']);               // Map { mcp => 2, dson => 1 }`,
  },
} satisfies Record<string, Snippet>;
export type SnippetId = keyof typeof snippets;
