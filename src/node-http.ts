/** VERIFIED: For JSON reply mode, end the Node response once with the buffered SDK output. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { toNodeHandler, toWebRequest } from '@modelcontextprotocol/node';
import type { McpHandlerRequestOptions } from '@modelcontextprotocol/server';
import { bodyTooLarge } from './errors.js';

interface NodeRequest extends IncomingMessage {
  body?: unknown;
  auth?: McpHandlerRequestOptions['authInfo'];
}

class BodyLimit extends Error {}

/**
 * Answer 413 and keep the connection open. Node discards the unread body after the response, so a client that sends
 * its whole body before reading the reply receives the status. VERIFIED: (probe, Python SDK 2.3.0) with
 * `connection: close` the socket closed during the upload, and httpx ended the whole session with a ReadError.
 */
function rejectLarge(res: ServerResponse, limit: number) {
  res.writeHead(413, { 'content-type': 'application/json' });
  res.end(JSON.stringify(bodyTooLarge(limit)));
}

/** Read a real socket exactly once. Retain chunks only until the configured byte cap. */
async function readBody(req: NodeRequest, limit: number): Promise<string> {
  if (Number(req.headers['content-length']) > limit) throw new BodyLimit();
  const parts: Buffer[] = [];
  let length = 0;
  for await (const piece of req.iterator({ destroyOnReturn: false })) {
    const part = Buffer.isBuffer(piece) ? piece : Buffer.from(piece);
    length += part.length;
    if (length > limit) {
      req.resume();
      throw new BodyLimit();
    }
    parts.push(part);
  }
  const raw = parts.length === 1 ? parts[0]!.toString('utf8') : Buffer.concat(parts, length).toString('utf8');
  return raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
}
function makeRequest(req: NodeRequest, raw: string, signal: AbortSignal) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined || name.startsWith(':')) continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else headers.set(name, value);
  }
  const authority = headers.get('host') ?? req.headers[':authority'] ?? 'localhost';
  return new Request('http://' + authority + (req.url ?? '/'), {
    method: 'POST',
    headers,
    signal,
    body: raw,
  });
}
/** SSE responses retain stream backpressure. Each socket owns its abort signal until response completion. */
export function nodeJsonHandler(
  dispatch: (
    req: Request,
    supplied?: McpHandlerRequestOptions,
    bounded?: boolean,
    rawText?: string,
  ) => Promise<Response>,
  maxRequestBodySize: number,
  authResponses: WeakSet<Response>,
) {
  return async (req: NodeRequest, res: ServerResponse) => {
    const abort = new AbortController();
    const disconnect = () => {
      if (!res.writableFinished) abort.abort();
    };
    res.once('close', disconnect);
    if (res.destroyed) abort.abort();
    try {
      const raw =
        req.method === 'POST' && req.body === undefined && typeof req.iterator === 'function'
          ? await readBody(req, maxRequestBodySize)
          : undefined;
      const web =
        raw === undefined
          ? await toWebRequest(req, req.body, { signal: abort.signal, maxRequestBodySize })
          : makeRequest(req, raw, abort.signal);
      const reply = await dispatch(web, { authInfo: req.auth, parsedBody: req.body }, true, raw);
      if (res.destroyed) {
        await reply.body?.cancel();
        return;
      }
      res.writeHead(reply.status, Object.fromEntries(reply.headers));
      if (!reply.body) res.end();
      else if (!authResponses.has(reply) && reply.headers.get('content-type')?.startsWith('application/json'))
        res.end(Buffer.from(await reply.arrayBuffer()));
      else await pipeline(Readable.fromWeb(reply.body as Parameters<typeof Readable.fromWeb>[0]), res);
    } catch (error) {
      if (res.destroyed) return;
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (error instanceof BodyLimit || (error instanceof Error && error.name === 'RequestBodyTooLargeError'))
        rejectLarge(res, maxRequestBodySize);
      else {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32603, message: 'Internal server error' } }));
      }
    } finally {
      res.off('close', disconnect);
    }
  };
}

type Dispatch = Parameters<typeof nodeJsonHandler>[0];
/** Adapt Node and Express requests. JSON mode ends a real ServerResponse in one write; other modes stream through the SDK adapter. */
export function nodeMiddleware(
  dispatch: Dispatch,
  mode: 'auto' | 'json' | 'sse',
  maxRequestBodySize: number,
  authResponses: WeakSet<Response>,
) {
  const buffered = mode === 'json' ? nodeJsonHandler(dispatch, maxRequestBodySize, authResponses) : undefined;
  const node = toNodeHandler({ fetch: (req, opts) => dispatch(req, opts, true) }, { maxRequestBodySize });
  return async (request: unknown, response: unknown): Promise<void> => {
    const req = request as NodeRequest;
    const res = response as ServerResponse;
    // The SDK adapter would answer this with connection: close, which resets a client still sending.
    if (Number(req.headers['content-length']) > maxRequestBodySize) return rejectLarge(res, maxRequestBodySize);
    if (buffered && 'writableFinished' in res && 'off' in res) await buffered(req, res);
    else await node(req, res, req.body);
  };
}
