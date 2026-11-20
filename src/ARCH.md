# Runtime source

| File | Responsibility and rationale |
|---|---|
| index.ts | Freeze registration when a transport starts. Copy tool titles, descriptions and annotations into the catalog. Keep one name map and one catalog so listing and lookup share names. DSON uses a JSON string envelope to retain cycles and rich types. |
| functions.ts | Inspect data descriptors once. Store the wire name, receiver and tuple index. Collect generator results under fixed bounds. |
| client.ts | Discover positional bindings once per client facade. Map object keys or tuple indices to DSON calls over the caller-owned SDK connection. |
| binary.ts | Validate canonical base64, retain view extents, and negotiate tagged scalar or byte trees with DSON graph fallback. Use Buffer where the runtime provides it, else Uint8Array base64 methods or atob and btoa. |
| node-http.ts | Choose the buffered JSON handler or the SDK's streaming Node adapter. In explicit JSON mode a real Node-compatible response can end in one write. Bound raw socket input and forward other response bodies with stream backpressure. Answer an oversized body with 413 on an open connection, which Node then drains. |
| errors.ts | Build the one JSON-RPC 413 error that the Fetch, bunway and Node paths return, with the limit in its message. |
| http.ts | Convert Express or bunway requests to the SDK Fetch entry. Import the Node adapter on the first Node request, so Fetch hosts load no Node module. Host, origin, request size and authorization apply before dispatch. A bounded parser shares the decoded POST with classification and dispatch. The legacy JSON branch uses the SDK transport with JSON replies enabled. |
| stdio.ts | Read newline-delimited messages from stdin in linear time with a message limit. Delegate parsing, protocol eras and sessions to the SDK. |
| validation.ts | Reuse compiled checks per serialized application schema and initialize each Ajv dialect on first use. A separate import keeps validator setup off the unchecked path. Invalid arguments return pointers and correction instructions. |
| rpc.ts | Discover methods once and dispatch through rpcRoute in process. Bounded NDJSON collection preserves the generator return and closes its reader after interruption. |

VERIFIED: Only the application invokes registered functions. Each new SDK server receives request-local context. Generator frames use defuss-dson because a JSON parser alone cannot restore a yielded BigInt or Map.

hooks.ts pairs start and finish events across transports and isolates sink failures. Decoded value processors share the application error boundary. A replacement is explicit so a callback can observe a value without changing it.

contracts.ts compiles named input and result conversions when registering a tool or binding a client. Fields use JSON Pointers for corrections. Generated calls exchange public named JSON and keep byte conversion inside the codec.

Why keep the connection open after a 413 instead of closing it: VERIFIED: (probe and tests/http-boundaries.test.ts) the official Python SDK writes a whole request before reading the reply. When the server closed the connection during an oversized upload, httpx raised a ReadError that ended the client's session, while TypeScript and Go clients read the status. Node discards the unread body after the response, and its request timeout bounds that work.

Why stdio.ts frames messages itself instead of using the SDK's StdioServerTransport: VERIFIED: (probe, SDK 2.4.0) the SDK's reader concatenates its whole buffer on every chunk, so one 8 MiB message in 64 KiB chunks took 129 ms and 418 MiB of resident memory on Node. LineTransport keeps the chunks of a partial message and joins them once, which took 14 ms and 1 MiB. It parses each line with the SDK's exported deserializeMessage and passes the transport to the SDK's serveStdio, so protocol handling stays the SDK's.

VERIFIED: A legacy JSON request can be waiting on an upstream generator when the HTTP peer leaves. The adapter settles the Fetch call on abort and releases the SDK server in a finally block. Compact encoding distinguishes callable serialization hooks from ordinary data properties named toJSON.
