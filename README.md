# defuss-mcp

Expose TypeScript functions as MCP tools from a child process, an Express route, a bunway route, or a Fetch handler. An application owns its listener and authentication. The same tool registry can serve all three response modes.

- **Functions become tools.** Register an object of functions. A TypeScript caller imports `typeof api` and calls `tools.add(2, 5)` with inferred parameter and result types.
- **Agents can repair their calls.** A generated contract publishes named JSON Schema from the signature and JSDoc. An invalid argument returns a JSON Pointer and an instruction, so the agent can resend a corrected call.
- **Bytes and rich values cross the wire intact.** Typed arrays travel as base64 trees, while Maps, BigInts, Dates and cycles use DSON. Plain JSON clients see ordinary schemas.
- **One registry serves every transport.** stdio, Express, bunway and Fetch share one frozen catalog in JSON, SSE or automatic Streamable HTTP reply mode.
- **RPC guards keep running.** The defuss-rpc bridge re-enters the RPC dispatcher, so method guards also apply to MCP callers.
- **Real clients are tested.** `make e2e` installs the packed tarball and passes 112 cells with the official TypeScript, Python and Go SDKs and the MCP Inspector CLI.

Coding agents can read [llms.txt](docs/llms.txt), a compact summary of this page with runnable examples.

## Contents

[Quick start](#quick-start) · [Function registration](#register-a-function-object-or-tuple) · [Agent discovery](#let-agents-discover-a-typescript-function) · [Binary payloads](#binary-payloads) · [Tool metadata](#describe-tools-for-hosts) · [Express, bunway and Fetch](#mount-on-express) · [Web-standard runtimes](#web-standard-runtimes) · [JSON and DSON](#json-and-dson-contracts) · [defuss-rpc](#expose-defuss-rpc-on-the-same-listener) · [Hooks](#call-logging-and-processing) · [Authentication](#authentication-and-limits) · [Message limits](#message-size-limits) · [Tested clients](#tested-clients) · [Develop](#develop)

## Install the local release

From the extracted project, install the tarball into your application.

```sh
bun add /path/to/defuss-mcp/validation/defuss-mcp-0.6.1.tgz
```

The library ships ESM, CommonJS and TypeScript declarations. The tested runtimes and client versions are in the [verification notes](docs/VERIFICATION.md).

## Quick start

This server exposes one function over Streamable HTTP with `Bun.serve`. Any MCP client can call it at `http://127.0.0.1:3000/mcp`.

```ts
// server.ts, run with: bun server.ts
import { createMcpApi } from 'defuss-mcp';
import { createMcpHttp } from 'defuss-mcp/http';

export const api = createMcpApi(
  { name: 'greeter', version: '1.0.0' },
  { greet(name: string) { return 'Hello, ' + name; } },
  { metadata: { greet: { title: 'Greet', annotations: { readOnlyHint: true } } } },
);
const endpoint = createMcpHttp(api);
Bun.serve({ hostname: '127.0.0.1', port: 3000, fetch: (request) => endpoint.fetch(request) });
```

A TypeScript client connects the official SDK and receives typed functions.

```ts
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { getMcpClient } from 'defuss-mcp/client';
import type { api } from './server.ts';

const sdk = new Client({ name: 'caller', version: '1.0.0' });
await sdk.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:3000/mcp')));
const { tools } = await getMcpClient<typeof api>(sdk);
console.log(await tools.greet('Ada')); // "Hello, Ada", typed as string
await sdk.close();
```

A plain JSON client calls `greet` with `{"args":["Ada"]}` and reads `structuredContent.value`. Add a [generated contract](#let-agents-discover-a-typescript-function) to advertise a named `name` parameter instead.

## Register a function object or tuple

```ts
// arithmetic.ts on the server
import { createMcpApi } from 'defuss-mcp';

const operations = {
  add(a: number, b: number) { return a + b; },
  async since(date: Date) { return date.getTime(); },
};
export const api = createMcpApi({ name: 'math', version: '1' }, operations);
```

```ts
// client.ts
import type { api } from './arithmetic.js';
import type { Client } from '@modelcontextprotocol/client';
import { getMcpClient } from 'defuss-mcp/client';

export async function run(sdk: Client) {
  const { tools } = await getMcpClient<typeof api>(sdk); // sdk is already connected
  const sum = await tools.add(2, 5);                    // number
  const epoch = await tools.since(new Date(0));         // number
  return { sum, epoch };
}
```

Object keys are wire names. The server registers own enumerable string-keyed functions on a plain object. A method keeps its original `this`, so it can use ordinary data fields on that object. Enumerable accessors are rejected at registration. Use an object to assign stable public names across bundling and minification.

An array registers functions in order. Each entry needs a nonempty, unique MCP-compatible `function.name`. A TypeScript tuple carries parameter and result types by position. A named function's runtime name does not appear as a literal in its TypeScript type.

```ts
function double(n: number) { return n * 2; }
function upper(s: string) { return s.toUpperCase(); }
const tuple = createMcpApi({ name: 'text-math', version: '1' }, [double, upper]);
// With a client connected to this API:
const { tools } = await getMcpClient<typeof tuple>(sdk);
await tools[0](21);       // number, wire name double
await tools[1]('hello');  // string, wire name upper
```

An inline array is inferred as a tuple. Add `as const` when declaring a heterogeneous array separately if callers need a distinct signature per index. Rest and optional parameters and awaited results survive discovery through the shared TypeScript declaration. Supply a concrete signature for a generic or overloaded function when its parameter and return types depend on each other.

Node and Bun typed clients negotiate compact positional arguments and results with v0.3. Older peers use DSON. A standard MCP client can call `add` with `{"args":[2,5]}` and read `structuredContent.value`. The JSON path requires JSON-compatible values. The function registry checks the positional envelope. Generate a named contract for agent discovery, or use `.json(name, schema, handler)` to supply a schema by hand.

Direct generators run to completion and return `{ items, result }`. The bounds are 1,024 yields and 1 MiB of DSON-encoded values, including the return. Streaming exchanges can report yield counts as MCP progress. Cancellation is observed between iterator steps. A function with long-running work can accept the call signal through an explicit `.json` or `.dson` handler.

The former `createMcp(identity, options)` remains available. Existing callers can change the name to `createMcpApi` with the same arguments. When the desired function object contains only the option names `compile` or `onError`, pass an explicit third argument, for example `createMcpApi(identity, { compile }, {})`.

## Let agents discover a TypeScript function

Keep a function in its own module and document what a caller needs to know.

```ts
// math.ts
/** Add equal-length byte arrays elementwise, modulo 256. */
export function add(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length !== b.length) throw new RangeError('Expected equal lengths.');
  return a.map((value, i) => value + b[i]!);
}
```

Generate the binding as part of the application's build, before compiling its TypeScript. The CLI loads the application's TypeScript compiler. Install TypeScript as a development dependency.

```sh
bun add -d typescript
bunx defuss-mcp --entry src/math.ts --out src/math.mcp.ts
```

```ts
import { createMcpApi } from 'defuss-mcp';
import { add, contracts } from './math.mcp.js';

const api = createMcpApi({ name: 'math', version: '1' }, { add });
```

Importing the generated module associates metadata with the original function object. Object aliases and named tuples retain their signatures. The entry exports a `contracts` map for the RPC bridge. In an application that calls `createRpcServer({ math: { add } })`, mount the tools on the same registry with `await exposeRpc(api, rpcRoute, { contracts: { math: contracts } })`. The qualified tool `math.add` goes through RPC guards. The direct tool `add` follows the application's direct MCP policy. Expose only the guarded route if access depends on an RPC guard.

A stock MCP client discovers named fields `a` and `b` with `type: "string"` and `contentEncoding: "base64"`. It can send `{"a":"AQI=","b":"AwQ="}` and read `{"value":"BAY="}` in `structuredContent`. An invalid second operand produces an `INVALID_ARGUMENTS` tool error with a correction at `/b`. The typed client still calls `tools.add(a, b)` and receives a `Uint8Array`. Native values are converted using the schemas advertised during discovery. Generated tools always use this named representation, including when a client requests DSON for other tools.

The generator reads named function exports, imported interfaces and JSDoc (summary, parameters and return). It supports finite JSON numbers, strings, booleans, null, primitive literals and same-kind literal unions, nullable values, closed records, arrays, bytes, optional/default and rest parameters, promises and void. Cross-field constraints such as equal lengths belong to the application. A shared DSON function can still take maps, cyclic graphs or application classes through the original registration path. For a module containing both kinds, use `--only add,subtract` to select exports. Unsupported selected signatures fail the build with a diagnostic. Use `--project path/to/tsconfig.json` to select a configuration and `--check` to reject stale generated output in CI. A project that runs TypeScript directly, as Bun and Node's type stripping do, sets `allowImportingTsExtensions` or `rewriteRelativeImportExtensions`. The generator then imports the source module with its own `.ts` extension, so import the binding as `./math.mcp.ts`. Without either option it writes the `.js` specifier that compiled output needs.

The named codec checks the published shape while converting fields, even without a schema compiler. Supply `{ compile: ajvValidator() }` as the third registration argument for an additional JSON Schema check. Generated inputs and outputs each have an aggregate 16 MiB decoded byte budget. HTTP body limits apply separately. Results use a `value` field (an empty object for void) across supported protocol versions. The 0.4 typed facade predates this named wire contract. Upgrade typed clients before opting an existing tool name into it, or expose the new contract under a new name during migration. Unbound functions keep the positional and DSON protocols.

## Binary payloads

An ordinary function can take any number of byte arguments. The typed client encodes the visible part of each view and restores the result automatically.

```ts
function add(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length !== b.length) throw new RangeError('Expected equal lengths.');
  return a.map((v, i) => v + b[i]);
}
const api = createMcpApi({ name: 'math', version: '1' }, { add });
const { tools } = await getMcpClient<typeof api>(sdk);
const sum = await tools.add(new Uint8Array([1, 2]), new Uint8Array([3, 4])); // [4, 6]
```

For an explicit one-field base64 schema that any JSON client can discover, register a binary tool. Its handler receives an exact-length `Uint8Array` and returns a `Uint8Array` or Node `Buffer`. Every MCP client can exchange `{"bytes":"<base64>"}` through ordinary `tools/call`. The encoded output is in `structuredContent.bytes`.

```ts
import { createMcpApi, encodeBytes, decodeBytes } from 'defuss-mcp';

const api = createMcpApi({ name: 'media', version: '1' });
api.binary('frame.echo', frame => frame, { maxBytes: 2 * 1024 * 1024 });

// With a connected SDK client and an application-owned input view:
const reply = await sdk.callTool({ name: 'frame.echo', arguments: encodeBytes(frame) });
if (reply.isError) throw new Error(JSON.stringify(reply.content));
const output = decodeBytes(reply.structuredContent);
```

```python
import base64

async def echo(client, frame: bytes) -> bytes:
    result = await client.call_tool("frame.echo", {"bytes": base64.b64encode(frame).decode("ascii")})
    if result.is_error:
        raise ValueError(result.content)
    return base64.b64decode(result.structured_content["bytes"], validate=True)
```

`maxBytes` limits decoded input and output, default 16 MiB. Base64 uses four characters per three source bytes, rounded to groups of four. The HTTP request limit applies to the entire JSON message and defaults to 4 MiB. Configure both limits for larger frames. Only the caller's selected slice crosses the wire. Bad padding, invalid characters and oversized inputs return a correction before invoking the handler.

Direct function registration also handles binary data. A v0.3 typed client uses the compact codec when the peer advertises it. It preserves byte slices, `ArrayBuffer`, `DataView`, fixed-width numeric typed arrays and nested plain records or arrays. Node Buffers arrive as `Uint8Array`. Numeric views use little-endian words and retain their bit patterns. Float16Array requires native support on both peers. Byte views are reconstructed with their visible extent and a zero byte offset. Each message may include up to 16 MiB of compact binary data, 4,096 tree nodes and 32 levels. Cycles, repeated objects, getters, unsupported types and trees beyond the encoder bounds use DSON. A rich DSON argument can still receive a compact binary reply from a negotiated peer. To select the previous codec explicitly, pass `{ codec: 'dson' }` as the second argument to `getMcpClient`.

## Describe tools for hosts

Hosts show a tool's `title` and may use its annotations, such as `readOnlyHint` and `destructiveHint`, to decide whether to ask the user before a call. Pass them per function in the registry options, keyed by wire name. A key that names no registered function fails registration, and TypeScript rejects it for an object of functions.

```ts
const api = createMcpApi({ name: 'files', version: '1' }, { list, remove }, {
  metadata: {
    list: { title: 'List files', annotations: { readOnlyHint: true } },
    remove: { title: 'Delete a file', description: 'Delete one file by path.', annotations: { destructiveHint: true } },
  },
});
```

`.json`, `.dson` and `.binary` accept the same `title`, `description` and `annotations` in their options. A generated contract supplies the JSDoc summary as the description, and registry metadata can replace it. The MCP specification calls annotations hints: a host should not trust them from an untrusted server, and they do not restrict what a tool does.

A JSON tool can declare the shape of its result with `outputSchema`. `tools/list` publishes it under the `value` field, where clients find the result. With `compile: ajvValidator()` installed, a result that violates the schema reaches `onError`, and the caller receives the generic tool error. `{ validate: false }` turns off both the input and the output check for that tool.

```ts
tools.json<{ path: string }>('stat', {
  type: 'object', properties: { path: { type: 'string' } }, required: ['path'],
}, ({ path }) => ({ path, bytes: 12 }), {
  outputSchema: { type: 'object', properties: { path: { type: 'string' }, bytes: { type: 'integer' } }, required: ['path', 'bytes'] },
});
```

## Mount on Express

```ts
import express from 'express';
import { createMcpApi } from 'defuss-mcp';
import { createMcpHttp } from 'defuss-mcp/http';
import { ajvValidator } from 'defuss-mcp/validation';

const tools = createMcpApi({ name: 'arithmetic', version: '1.0.0' }, { compile: ajvValidator() });
tools.json<{ a: number; b: number }>('add', {
  type: 'object',
  properties: { a: { type: 'number' }, b: { type: 'number' } },
  required: ['a', 'b'],
  additionalProperties: false,
}, ({ a, b }) => a + b, { description: 'Add two numbers.' });

const token = process.env.MCP_API_TOKEN;
if (!token) throw new Error('Set MCP_API_TOKEN before starting the server.');
const endpoint = createMcpHttp(tools, {
  authorize: request => request.headers.get('authorization') === 'Bearer ' + token,
});
const app = express();
app.all('/mcp', endpoint.middleware);
app.listen(3000, '127.0.0.1');
```

A bunway application mounts the same handler with `app.all('/mcp', endpoint.middleware)`. A Fetch router passes the matching request to `endpoint.fetch(request)`. The handler supports an upstream `express.json()` parser. Mount it before body-consuming middleware on bunway so its original Fetch body remains readable. Register tools before constructing the first transport.

| Entry | Use |
|---|---|
| `createMcpHttp(tools, { mode: 'auto' })` | Default. Current clients receive JSON for one reply and SSE when the tool sends progress. Handshake-era clients receive SSE. |
| `createMcpHttp(tools, { mode: 'json' })` | One JSON tool reply in either era. Mid-call progress is omitted. |
| `createMcpHttp(tools, { mode: 'sse' })` | A request-scoped SSE stream carries progress and the final tool reply. |
| `await serveMcpStdio(tools, options?)` from `defuss-mcp/stdio` | Run inside the child launched by the client. The returned handle has `close()`. Keep stdout for protocol messages and use stderr for application logs. `maxMessageBytes` and `onerror` are described under [message size limits](#message-size-limits). |

For long operations, check the handler's `context.signal` and await `context.progress(completed, total, message)`. The caller supplies a progress callback to request notifications. For HTTP, `context.request` carries the original request headers. A child process gets its credentials through its launch environment.

## Web-standard runtimes

The core registry, the typed client and `endpoint.fetch` need only web-standard APIs: `Request`, `Response`, streams and `TextEncoder`. Base64 uses `Buffer` where the runtime provides it, otherwise the `Uint8Array` base64 methods or `atob` and `btoa`. `defuss-mcp/http` loads its Node request adapters on the first `middleware` call, so a host that only calls `fetch` never imports `node:stream`. In the paired benchmark this shortens a fresh process's import of the index and HTTP entries, as listed in `validation/comparison.md`. The first Express or raw Node request pays that import instead.

VERIFIED: The [project website](docs/index.html) bundles the published build for the browser, registers tools in the page and connects the official SDK client to `endpoint.fetch`. Its Playwright suite runs that demo in Chromium, Firefox and WebKit. `defuss-mcp/stdio` needs process pipes, and Ajv in `defuss-mcp/validation` compiles each schema into a function at runtime. The [verification notes](docs/VERIFICATION.md#website) list the runtimes outside this evidence.

## JSON and DSON contracts

A JSON tool advertises its object schema in `tools/list`. Passing `compile: ajvValidator()` validates every JSON tool by default. Set `{ validate: false }` on an individual tool to skip its check. Omit the compiler for an entirely unchecked registry. Unsupported dialects and unresolvable schema references fail at registration when validation is enabled. Supply schemas from application code.

The validation entry compiles JSON Schema 2020-12 and explicitly declared draft-07, including formats. A failing call skips the handler and returns MCP `isError: true`, a retry instruction, and up to 16 issues. Each issue contains a JSON Pointer, violated keyword, instruction, and constraint parameters. For instance, passing a string to `add.a` reports `/a` and requests a number. An agent can submit the corrected call on the same connection. A successful JSON result carries `structuredContent.value`. Return JSON-compatible data for this path.

DSON tools accept an MCP object with one string field named `dson`. Its contents are the actual output of `DSON.stringify`. The receiver decodes the graph, then passes it to the handler under the application's shared TypeScript type. The library checks the envelope and decoding. Application field validation is opt-in through the separate JSON tool API.

```ts
import { createMcpApi, encodeDson, decodeDson } from 'defuss-mcp';
import type { Client } from '@modelcontextprotocol/client';

interface Ledger { balances: Map<string, bigint>; asOf: Date }
const ledger = createMcpApi({ name: 'ledger', version: '1' });
ledger.dson<Ledger>('roundtrip', entry => entry);

export async function roundtrip(client: Client, state: Ledger): Promise<Ledger> {
  const result = await client.callTool({ name: 'roundtrip', arguments: encodeDson(state) });
  if (result.isError) throw new Error(JSON.stringify(result.content));
  return decodeDson<Ledger>(result.structuredContent);
}
```

A handler can throw `ToolFault` with an agent-readable instruction. Other handler exceptions return a generic tool error. `createMcpApi(identity, { onError })` receives the original exception for application diagnostics.

## Expose defuss-rpc on the same listener

```ts
import { createRpcServer, rpcRoute } from 'defuss-rpc/server';
import { ExpressRpcServer } from 'defuss-rpc/express-server';
import { expressProvider } from 'defuss-rpc/providers/express';
import { createMcpApi } from 'defuss-mcp';
import { createMcpHttp } from 'defuss-mcp/http';
import { exposeRpc } from 'defuss-mcp/rpc';

createRpcServer({ MathApi: { add(a: number, b: number) { return a + b; } } });
const tools = createMcpApi({ name: 'math', version: '1' });
await exposeRpc(tools, rpcRoute, { codec: 'json' });

const server = new ExpressRpcServer({ provider: expressProvider(), host: '127.0.0.1', port: 3000 });
server.getApp().all('/mcp', createMcpHttp(tools).middleware);
await server.start();
```

An RPC client calls `rpc.MathApi.add(2, 3)`. An MCP client calls `MathApi.add` with `{ args: [2, 3] }` in JSON mode. The default RPC bridge codec is DSON and takes `encodeDson({ args: [2, 3] })`. This preserves rich RPC arguments and results. A plain JSON agent can discover positional calls in JSON mode. To advertise descriptive named parameters and constraints, register a JSON tool with its own schema.

Discovery reads the RPC schema once and exposes each listed module function and class method as `Namespace.method`. The bridge calls the in-process RPC dispatcher with request headers and signal. RPC guards and class construction run on every call. Mount authorization middleware on both paths when it protects the original RPC endpoint. Use `include(namespace, method)` to restrict discovery and `prefix` to disambiguate names. File upload and download handlers are distinct RPC endpoints.

An RPC generator returns `{ items, result }`, including its final return value. Streaming callers that request progress receive the yielded item count as intermediate notifications. The default collection limit is 1,024 yields and 1 MiB of encoded frames per call. `maxStreamItems` and `maxStreamBytes` set those bounds. An exceeded limit or cancellation closes the reader. The runnable [shared server](examples/server.ts) covers classes, guards, generators, three HTTP modes and stdio.

## Call logging and processing

Configure hooks on the serving registry before creating a transport. The example writes one JSON line per event to stderr, which also works in a stdio child.

```ts
api.observeCalls(event => {
  process.stderr.write(JSON.stringify({ time: new Date().toISOString(), level: 'info', ...event }) + '\n');
});
```

A dispatched `tools/call` emits a start and a finish with a registry-local numeric ID, tool name and transport. Finish adds `status` (`ok`, `error`, or `cancelled`) and `durationMs`. The duration covers server dispatch, including validation, processors, the handler and result projection. It excludes both observer callbacks and transport delivery. Cancellation is reported when dispatch settles. Schema failures and unknown tools count as errors. HTTP rejections before dispatch belong in the host's access log. Each sink receives metadata only. Observers and their optional second-argument error sink can return promises. The server waits for them and isolates their errors from the caller. A sink that blocks also delays the call.

Use `processCalls` for trusted application code that needs decoded values or the request context. Before receives a positional array for registered functions, the input object for JSON, the restored graph for DSON, or the byte view for a binary tool. After receives the successful handler result before encoding. Returning nothing retains the value. Returning `{ value }` replaces it, including an explicit `undefined`. Tool schema validation and byte limits still apply. Preserve the published function's TypeScript contract when transforming values.

```ts
api.processCalls({
  before({ tool, context }, input) {
    context.signal.throwIfAborted();
    if (tool === 'add' && Array.isArray(input)) {
      const [a, b] = input;
      if (a instanceof Uint8Array && b instanceof Uint8Array && a.length !== b.length)
        throw new ToolFault('Send byte arrays of equal length.');
    }
  },
  after({ tool }, result) {
    if (tool === 'add' && result instanceof Uint8Array) metrics.recordBytes(result.byteLength);
  },
});
```

Import `ToolFault` from `defuss-mcp` and supply the application's metrics sink for this example. Processor failures follow normal tool error handling. Configure either hook once per registry. A later configuration before serving replaces the previous one. Both hooks apply to tools exposed through the RPC bridge. Direct calls to the separate RPC route use defuss-rpc's hooks. With observation disabled, the server dispatches directly without reading a clock or allocating log events.

## Authentication and limits

`authorize(request)` runs for every HTTP exchange, including discovery. Return `true` to allow, `false` for the default 401 Bearer challenge, or a `Response` to supply your own status, headers and body. Use your verifier here for API keys or OAuth access tokens. The application owns credential issuance and OAuth discovery. A client can send any custom header through its transport options. See the [client examples](docs/CLIENTS.md).

HTTP accepts loopback hostnames by default. Set `allowedHosts` to your public hostnames without ports. Requests with an Origin must match the request origin by default. Set `allowedOrigins` to the exact public browser origins for a proxy or cross-origin client, and configure CORS on the containing app. The default HTTP body limit is 4 MiB. Use `maxBodyBytes` to change it. Configure any upstream parser's own limit too.

The registry also supports atomic group registration. `await tools.group(staged => { staged.json("clock", { type: "object" }, () => Date.now()); })` publishes every staged tool together. Registration failures leave the destination intact.

## Message size limits

| Limit | Default | Option | When exceeded |
|---|---|---|---|
| HTTP request body | 4 MiB | `maxBodyBytes` of `createMcpHttp` | HTTP 413 with a JSON-RPC error that names the limit. The connection and the client's session stay usable. |
| stdio inbound message | 10 MiB | `maxMessageBytes` of `serveMcpStdio` | The connection closes, and `onerror` receives the reason. |
| Decoded binary data | 16 MiB | `maxBytes` of `.binary` | A correction for an argument, a tool error for a result. Generated contracts have the same budget. |

Base64 enlarges bytes by a third. With the defaults, an HTTP upload carries up to about 3 MiB of binary data and a stdio message about 7 MiB. A download can reach the 16 MiB codec budget, because HTTP replies have no request limit.

```ts
const endpoint = createMcpHttp(api, { maxBodyBytes: 32 * 1024 * 1024 });
await serveMcpStdio(api, {
  maxMessageBytes: 32 * 1024 * 1024,
  onerror: (error) => console.error(JSON.stringify({ time: new Date().toISOString(), level: 'error', message: error.message })),
});
```

VERIFIED: `make e2e` uploads just under the HTTP limit and downloads 11 MiB in every HTTP cell, and moves 6 MiB each way over stdio. For the TypeScript and Python SDKs it also checks that an oversized upload fails while the session keeps working. `serveMcpStdio` reads stdin in linear time. With the SDK's own stdio reader, one 8 MiB message took 129 ms and 418 MiB of resident memory on Node. The [verification notes](docs/VERIFICATION.md#large-messages) list throughput and server memory.

Clients enforce their own limits. VERIFIED: (probes) The Python SDK 2.3.0 rejects an SSE event over 1 MiB. Pass a larger `max_sse_event_size` to `streamable_http_client`, or serve large results in JSON mode. The Go SDK 1.8.0 reads stdio lines up to 16 MiB, and its `CommandTransport` has no option to raise that. It also closes its session after an HTTP 413. The TypeScript SDK's `StdioClientTransport` buffers 10 MiB unless it receives `maxBufferSize`. The MCP Inspector CLI 2.16.0 drops an SSE line over 16 MiB, so its call waits until its one-minute timeout.

## Tested clients

The packed-package suite uses the official TypeScript SDK on Node and Bun, the official Python and Go SDKs, and the MCP Inspector CLI. Go discovers a byte tool, repairs a rejected field and calls the guarded RPC bridge. Inspector invokes the same byte tool as an external CLI. Each runs over stdio and the JSON, SSE and automatic Streamable HTTP response modes. `make e2e` fails when any of the 112 client cells fails or is missing. The VAE gate then checks that `output/e2e.json` covers every cell and came from the tarball the current tree packs. See [the verification matrix](docs/VERIFICATION.md).

## Develop

Use the tools pinned in `mise.toml`; `eval "$(mise env -s bash)"` puts them ahead of other installations on `PATH`. Run `make setup` for locked dependencies and the pinned VAE runtime. Bun runs the examples, scripts and `make test`. `make coverage` reruns the same suite on Node, the other supported runtime. Python and Go appear only as the official SDK clients of the matrix. `make verify` typechecks, lints, measures coverage, packs the package, and tests the installed consumer. `make bench` measures client-visible calls and writes raw results, including a paired comparison with the bundled v0.4.0 tarball. `make bench-add` reproduces the two-operand byte-addition and hook comparison. `make metrics` prints the comparison. `make start` and `make stop` control the optional loopback example on port 63921. `make site` builds the website from `site/` into `docs/`, and `make e2e` runs its Playwright suite in Chromium, Firefox and WebKit.

VAE uses a Git worktree. Run `git init` in a standalone unpacked copy before `make vae`. The gate checks verification, review and documentation for the current fingerprint. `make release` builds a local source ZIP and installable tarball. [Architecture](ARCH.md) · [Research](docs/RESEARCH.md) · [Verification and limits](docs/VERIFICATION.md)
