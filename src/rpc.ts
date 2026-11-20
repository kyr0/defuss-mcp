/** VERIFIED: The bridge re-enters rpcRoute so method guards run for MCP callers. Generator collection has byte and item budgets. */
import { DSON } from 'defuss-dson';
import { ToolFault, type FunctionContract, type ToolContext, type ToolRegistry } from './index.js';

type RpcRoute = (context: { request: Request }) => Promise<Response>;
interface RpcEntry {
  className?: string;
  moduleName?: string;
  methods: Record<string, { generator: boolean }>;
}
/** Select and name discovered RPC methods and bound the collection of generator output. */
export interface RpcOptions {
  /** Generated method contracts grouped by the original RPC namespace. */
  contracts?: Record<string, Record<string, FunctionContract>>;
  /** Prepend this literal string to namespace.method tool names. Defaults to the empty string. */
  prefix?: string;
  /** For methods without generated contracts, use DSON by default or JSON positional arguments. */
  codec?: 'json' | 'dson';
  /** Return true to expose a discovered namespace/method pair. Applies before registration. */
  include?: (namespace: string, method: string) => boolean;
  /** Maximum wire bytes read per generator result, including frame overhead. Defaults to 1 MiB. */
  maxStreamBytes?: number;
  /** Maximum yielded items per collected generator result. Defaults to 1024. */
  maxStreamItems?: number;
}
const rpcArgsSchema = {
  type: 'object' as const,
  properties: { args: { type: 'array', items: {} } },
  required: ['args'],
  additionalProperties: false,
};

/** Consume defuss-rpc's NDJSON frames, cancel the iterator on abort or limit, and preserve its return. */
async function collectStream(response: Response, ctx: ToolContext, maxBytes: number, maxItems: number) {
  if (!response.body) throw new ToolFault('RPC returned an empty generator response.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const items: unknown[] = [];
  let bytes = 0,
    pending = '';
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  ctx.signal.addEventListener('abort', cancel, { once: true });
  try {
    while (true) {
      ctx.signal.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) throw new ToolFault('RPC generator ended before its return frame.');
      bytes += value.byteLength;
      if (bytes > maxBytes) throw new ToolFault('RPC generator exceeded its byte limit.');
      pending += decoder.decode(value, { stream: true });
      const lines = pending.split('\n');
      pending = lines.pop()!;
      for (const line of lines) {
        const frame = DSON.parse(line);
        if (frame.type === 'return') return { items, result: frame.value };
        if (frame.type === 'error') throw new ToolFault('RPC generator failed.');
        if (frame.type !== 'yield') throw new ToolFault('Unknown RPC generator frame.');
        if (items.length >= maxItems) throw new ToolFault('RPC generator exceeded its item limit.');
        items.push(frame.value);
        await ctx.progress(items.length);
      }
    }
  } finally {
    ctx.signal.removeEventListener('abort', cancel);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Discover and register a defuss-rpc catalog atomically. Calls forward request headers and cancellation through rpcRoute so guards still run. Generator results contain items and result. Discovery or registration failure rejects before publishing the batch. */
export async function exposeRpc(
  registry: ToolRegistry,
  route: RpcRoute,
  options: RpcOptions = {},
): Promise<void> {
  const bytes = options.maxStreamBytes ?? 1024 * 1024;
  const items = options.maxStreamItems ?? 1024;
  if (![bytes, items].every((n) => Number.isSafeInteger(n) && n > 0))
    throw new RangeError('Invalid RPC generator limit.');
  const response = await route({ request: new Request('http://localhost/rpc/schema') });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error('RPC discovery failed: ' + response.status);
  }
  const entries = (await response.json()) as RpcEntry[];
  await registry.group((staged) => {
    for (const entry of entries) {
      const namespace = entry.className ?? entry.moduleName;
      if (!namespace) throw new Error('RPC descriptor is missing a namespace.');
      for (const [method, descriptor] of Object.entries(entry.methods)) {
        if (options.include && !options.include(namespace, method)) continue;
        const name = (options.prefix ?? '') + namespace + '.' + method;
        const description = 'Call ' + namespace + '.' + method + ' with positional args.';
        const invoke = async (input: { args: unknown[] }, ctx: ToolContext) => {
          if (!Array.isArray(input?.args))
            throw new ToolFault('Supply an object with an args array in parameter order.');
          const headers = new Headers(ctx.request?.headers);
          // These describe the outside MCP envelope. Let Fetch frame the new RPC body.
          for (const key of [
            'content-length',
            'transfer-encoding',
            'connection',
            'content-encoding',
            'accept',
          ])
            headers.delete(key);
          headers.set('content-type', 'application/json');
          const request = new Request(new URL('/rpc', ctx.request?.url ?? 'http://localhost'), {
            method: 'POST',
            headers,
            signal: ctx.signal,
            body: DSON.stringify({ className: namespace, methodName: method, args: input.args }),
          });
          const result = await route({ request });
          if (!result.ok) {
            await result.body?.cancel();
            throw new ToolFault('RPC call rejected (HTTP ' + result.status + ').');
          }
          return descriptor.generator
            ? collectStream(result, ctx, bytes, items)
            : DSON.parse(await result.text());
        };
        const methods =
          options.contracts && Object.hasOwn(options.contracts, namespace)
            ? options.contracts[namespace]
            : undefined;
        const contract = methods && Object.hasOwn(methods, method) ? methods[method] : undefined;
        if (contract) staged.named(name, contract, (args, ctx) => invoke({ args }, ctx));
        else if (options.codec === 'json') staged.json(name, rpcArgsSchema, invoke, { description });
        else staged.dson(name, invoke, { description });
      }
    }
  });
}
