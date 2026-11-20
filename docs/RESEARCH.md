# Protocol and implementation choices

The 2026-07-28 MCP revision uses per-request metadata and server/discover. Older clients open with initialize. The official TypeScript v2 server supplies both paths, stdio framing, progress and cancellation. The two HTTP reply encodings share Streamable HTTP. The split-endpoint SSE transport from 2024 is a different protocol. [Bindings](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports) · [SDK negotiation](https://ts.sdk.modelcontextprotocol.io/v2/protocol-versions)

The official TypeScript and Python SDKs are Tier 1. We selected @modelcontextprotocol/client and server 2.4.0 and Python mcp 2.3.0, the stable registry versions observed on 2026-11-19. Tier describes support and conformance. Market share was not measured. [SDK tiers](https://modelcontextprotocol.io/docs/sdk) · [Python client](https://py.sdk.modelcontextprotocol.io/client/)

defuss-rpc 2.0.0 exposes its provider app via getApp(). Express serves Node and Bun. bunway passes its original Fetch Request through on Bun. Its RPC schema lists modules, class methods and generators. Delegating to rpcRoute preserves class lifetime and guards, including those installed after tool discovery. RPC descriptors describe calling conventions, not parameter types. [RPC providers](https://github.com/kyr0/defuss-rpc/tree/main/src/providers) · [Dispatcher](https://github.com/kyr0/defuss-rpc/blob/main/src/server.ts)

JSON Schema 2020-12 is the default dialect for MCP. Ajv compiles trusted application schemas up front. The independent DSON wire envelope stores defuss-dson text in a standard MCP arguments object so a client can preserve graphs or BigInt using a shared TypeScript contract. [MCP schema](https://modelcontextprotocol.io/specification/2026-07-28) · [Ajv dialects](https://ajv.js.org/json-schema.html) · [DSON](https://github.com/kyr0/defuss-dson)

The tool registry accepts a staged group so discovery can publish a complete RPC catalog atomically. If a later mapped name collides, the previous catalog remains callable and the caller can retry with another prefix.

The defuss-rpc client takes a shared TypeScript contract. The MCP facade follows that pattern with a type-only server import. The MCP server lists the positional wire shape and stores binding positions as namespaced tool metadata. Ajv recommends reusing compiled validators. A per-compiler cache also works for copied schemas with identical JSON text. [defuss-rpc](https://github.com/kyr0/defuss-rpc) · [Ajv schema management](https://ajv.js.org/guide/managing-schemas.html)
