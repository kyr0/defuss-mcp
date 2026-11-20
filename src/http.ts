/** VERIFIED: JSON, SSE and automatic response modes share the SDK dispatcher. Node and bunway need different request adapters. */
import {
  createMcpHandler,
  isLegacyRequest,
  isJsonContentType,
  readRequestBody,
  WebStandardStreamableHTTPServerTransport,
} from '@modelcontextprotocol/server';
import type { McpHandlerRequestOptions } from '@modelcontextprotocol/server';
import type { ToolRegistry } from './index.js';
import { bodyTooLarge } from './errors.js';

/** Configure an endpoint mounted on a caller-owned HTTP server. */
export interface HttpOptions {
  /** Select the Streamable HTTP reply format. The auto default lets the SDK negotiate with the client. */
  mode?: 'auto' | 'json' | 'sse';
  /** Hostname allowlist without ports. Defaults to localhost and the IPv4 and IPv6 loopback addresses. */
  allowedHosts?: readonly string[];
  /** Exact allowed Origin values. Defaults to the request URL origin when an Origin header is present. */
  allowedOrigins?: readonly string[];
  /** Maximum encoded HTTP body in bytes. Defaults to 4 MiB. Applied before dispatch to unread bodies. */
  maxBodyBytes?: number;
  /** Inspect request headers before dispatch. True allows a call, false sends a Bearer challenge, and a Response supplies the full denial. */
  authorize?: (request: Request) => boolean | Response | Promise<boolean | Response>;
}
/** One mounted endpoint. Its lifecycle is independent of other routes on the same listener. */
export interface McpHttpEndpoint {
  /** Dispatch one web-standard Request and return the negotiated response, including a streaming body. */
  fetch(request: Request): Promise<Response>;
  /** Terminal handler for app.all(path, middleware). Accepts Node request/response or bunway wrappers. */
  middleware(request: unknown, response: unknown): Promise<void>;
  /** Reject subsequent requests with HTTP 503 and release SDK resources. The shared listener stays owned by the host. */
  close(): Promise<void>;
}
interface BunwayRequest {
  original: Request;
}
interface BunwayResponse {
  status(code: number): unknown;
  set(name: string, value: string): unknown;
  end(body?: ReadableStream<Uint8Array>): unknown;
}
const loopback = ['127.0.0.1', '[::1]', 'localhost'];
type BodyRead = Awaited<ReturnType<typeof readRequestBody>>;
/** Read a body up to limit bytes. Firefox's Request has no body stream, so read its buffered body whole, then check the size. */
async function readBounded(request: Request, limit: number): Promise<BodyRead> {
  if (request.body !== undefined) return readRequestBody(request, limit);
  const bytes = await request.arrayBuffer();
  return bytes.byteLength > limit ? { tooLarge: true } : { tooLarge: false, text: new TextDecoder().decode(bytes) };
}

/** Mount a frozen tool catalog on Fetch, Express or bunway. The caller owns the listener and calls close during shutdown. */
export function createMcpHttp(tools: ToolRegistry, options: HttpOptions = {}): McpHttpEndpoint {
  const factory = tools.factory();
  const mode = options.mode ?? 'auto';
  const maxRequestBodySize = options.maxBodyBytes ?? 4 * 1024 * 1024;
  if (!Number.isSafeInteger(maxRequestBodySize) || maxRequestBodySize < 1)
    throw new RangeError('Invalid maxBodyBytes.');
  const hosts = new Set((options.allowedHosts ?? loopback).map((host) => host.toLowerCase()));
  const origins = new Set(options.allowedOrigins ?? []);
  const sdk = createMcpHandler(factory, { responseMode: mode, maxRequestBodySize });
  const authResponses = new WeakSet<Response>();
  let closed = false;

  async function fetch(
    request: Request,
    supplied?: McpHandlerRequestOptions,
    bounded = false,
    rawText?: string,
  ): Promise<Response> {
    if (closed) return new Response('Endpoint closed', { status: 503 });
    const url = new URL(request.url);
    const host = request.headers.get('host');
    if (
      !hosts.has(url.hostname) ||
      (host !== null &&
        host.toLowerCase() !== url.host &&
        (url.port !== '' ||
          host.toLowerCase() !== url.hostname + (url.protocol === 'https:' ? ':443' : ':80')))
    )
      return new Response('Forbidden host', { status: 403 });
    const origin = request.headers.get('origin');
    if (origin !== null && (options.allowedOrigins ? !origins.has(origin) : origin !== url.origin))
      return new Response('Forbidden origin', { status: 403 });
    if (options.authorize) {
      const decision = await options.authorize(request);
      if (decision instanceof Response) {
        authResponses.add(decision);
        return decision;
      }
      if (decision !== true)
        return new Response('Authentication required', {
          status: 401,
          headers: { 'WWW-Authenticate': 'Bearer' },
        });
    }
    if (Number(request.headers.get('content-length')) > maxRequestBodySize)
      return Response.json(bodyTooLarge(maxRequestBodySize), { status: 413 });
    // Pass a single bounded parse to classification and dispatch. The SDK would otherwise
    // tee the body to preserve it for legacy fallback and re-read it in legacy JSON mode.
    if (
      request.method === 'POST' &&
      supplied?.parsedBody === undefined &&
      isJsonContentType(request.headers.get('content-type'))
    ) {
      let raw: BodyRead;
      try {
        // toNodeHandler already bounded and materialized this exact body from the socket.
        raw = bounded
          ? {
              tooLarge: false,
              text: rawText !== undefined && !request.bodyUsed ? rawText : await request.text(),
            }
          : await readBounded(request, maxRequestBodySize);
      } catch {
        return Response.json(
          { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Unreadable request body' } },
          { status: 400 },
        );
      }
      if (raw.tooLarge) return Response.json(bodyTooLarge(maxRequestBodySize), { status: 413 });
      try {
        supplied = { ...supplied, parsedBody: JSON.parse(raw.text) };
      } catch {
        // Let the SDK apply its original error and media negotiation rules to malformed input.
        request = new Request(request.url, {
          method: request.method,
          headers: request.headers,
          signal: request.signal,
          body: raw.text,
        });
      }
    }
    // The SDK applies responseMode to modern requests. Select its JSON-capable
    // legacy transport explicitly for initialize-era clients of a JSON endpoint.
    if (
      mode === 'json' &&
      request.method === 'POST' &&
      request.headers.get('mcp-protocol-version') !== '2026-07-28' &&
      (await isLegacyRequest(request, supplied?.parsedBody, { maxRequestBodySize }))
    ) {
      const server = await factory({ era: 'legacy', requestInfo: request, authInfo: supplied?.authInfo });
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
        maxRequestBodySize,
      });
      await server.connect(transport);
      const { signal } = request;
      // Closing the legacy SDK server cancels tool work, but its pending JSON reply can stay
      // unresolved. Settle this caller on abort and always release the per-request server below.
      let abort: (() => void) | undefined;
      try {
        signal.throwIfAborted();
        return await new Promise<Response>((resolve, reject) => {
          abort = () => reject(signal.reason);
          signal.addEventListener('abort', abort, { once: true });
          transport.handleRequest(request, supplied).then(resolve, reject);
        });
      } finally {
        if (abort) signal.removeEventListener('abort', abort);
        await server.close();
      }
    }
    return sdk.fetch(request, supplied);
  }

  // Node's request adapters load on first use. A host that only calls fetch() therefore never
  // imports node:stream or @modelcontextprotocol/node, which also keeps the entry browser-safe.
  let nodeHandler: Promise<(request: unknown, response: unknown) => Promise<void>> | undefined;
  /** A terminal route handler for app.all(path, middleware). Express may have parsed the body already. */
  async function middleware(request: unknown, response: unknown): Promise<void> {
    const original = (request as Partial<BunwayRequest>).original;
    if (original instanceof Request) {
      const result = await fetch(original);
      const res = response as BunwayResponse;
      res.status(result.status);
      for (const [name, value] of result.headers) res.set(name, value);
      res.end(result.body ?? undefined);
      return;
    }
    nodeHandler ??= import('./node-http.js').then((node) =>
      node.nodeMiddleware(fetch, mode, maxRequestBodySize, authResponses),
    );
    await (await nodeHandler)(request, response);
  }
  return {
    fetch: (request: Request) => fetch(request),
    middleware,
    async close() {
      closed = true;
      await sdk.close();
    },
  };
}
