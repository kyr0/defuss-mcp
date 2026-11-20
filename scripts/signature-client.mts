/** VERIFIED: Generate a binding before compiling this ordinary consumer, then serve it through the packaged SDK. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createMcpApi } from 'defuss-mcp';
import { createMcpHttp } from 'defuss-mcp/http';
import { getMcpClient } from 'defuss-mcp/client';
import { extract } from './generated.mjs';
import { extract as original } from './signature-fixture.mjs';
assert.equal(extract, original);
const identity = { name: 'packed-test', version: '1' };
const api = createMcpApi(identity, { extract });
// Load the registry through the other package entry. A generated ESM binding must still be visible.
const require = createRequire(import.meta.url);
const cjs: typeof import('defuss-mcp') = require('defuss-mcp');
const http = createMcpHttp(cjs.createMcpApi(identity, { extract }));
const sdk = new Client(identity);
try {
  await sdk.connect(
    new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), {
      fetch: (url, init) => http.fetch(new Request(url, init)),
    }),
  );
  const tools = (await sdk.listTools()).tools;
  assert.deepEqual(tools[0]?.inputSchema.required, ['frame']);
  const bound = await getMcpClient<typeof api>(sdk);
  const bytes: Uint8Array = await bound.tools.extract({ payload: new Uint8Array([5, 7]), tag: 'right' });
  assert.deepEqual(bytes, new Uint8Array([5, 7]));
  // @ts-expect-error the generated module preserves the nested binary input type
  const invalidCall = () => bound.tools.extract({ payload: 'BQc=' });
  void invalidCall;
} finally {
  await sdk.close();
  await http.close();
}
