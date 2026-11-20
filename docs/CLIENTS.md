# Connect a client

Install the official client with `bun add @modelcontextprotocol/client@2.4.0` or `uv add mcp==2.3.0 httpx2==2.16.2`. The examples target the loopback server from `make start`, which runs `bun examples/server.ts`. The matrix also runs that file on Node 24.22.3, since it uses only erasable TypeScript syntax. Its demonstration credential is confined to that example.

## TypeScript on Node or Bun

```ts
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const http = new StreamableHTTPClientTransport(new URL('http://127.0.0.1:63921/mcp/sse'), {
  requestInit: { headers: { 'x-demo-key': 'demo', 'x-scope': 'read' } },
});
const child = new StdioClientTransport({ command: 'bun', args: ['examples/server.ts', 'stdio'] });
const client = new Client({ name: 'example', version: '1' });
try {
  await client.connect(process.argv.includes('--stdio') ? child : http);
  const result = await client.callTool({ name: 'add', arguments: { a: 2, b: 5 } });
  console.log(result.structuredContent);
} finally {
  await client.close();
}
```

## Python

```python
import asyncio
import httpx2
from mcp import Client, StdioServerParameters
from mcp.client.streamable_http import streamable_http_client

async def main():
    async with httpx2.AsyncClient(headers={"x-demo-key": "demo"}) as http:
        transport = streamable_http_client("http://127.0.0.1:63921/mcp/json", http_client=http)
        async with Client(transport) as client:
            result = await client.call_tool("add", {"a": 2, "b": 5})
            print(result.structured_content)
            direct = await client.call_tool("directAdd", {"args": [2, 5]})
            print(direct.structured_content["value"])

    child = StdioServerParameters(command="bun", args=["examples/server.ts", "stdio"])
    async with Client(child) as client:
        print((await client.list_tools()).tools)

asyncio.run(main())
```

Both SDKs can use either HTTP response mode. The URL selects the example's reply encoding. Applications can instead mount a single endpoint in automatic mode.

For a generated tool, read its named input fields and output schema from tools/list. Send byte fields as base64 strings. A validation error supplies a JSON Pointer and correction instruction. The TypeScript facade handles encoding and decoding when using the shared function type.
