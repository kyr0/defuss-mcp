/** VERIFIED: Each bound function sends a standard tools/call and restores a lossless DSON result. */
import { compactKey, decodeBytes, packArguments, unpackValue } from './binary.js';
import { namedKey, makeContractCodec, type FunctionContract } from './contracts.js';
import { DSON } from 'defuss-dson';
import { bindingKey, collectionKey, type ApiFunction, type RemoteFunction } from './functions.js';
import type { FunctionsOf, McpApi } from './index.js';
import type { CallToolResult, ListToolsResult } from '@modelcontextprotocol/server';

export type { ApiFunction, FunctionResult, RemoteFunction } from './functions.js';

/** Structural subset of a connected MCP client. Its creator retains ownership of the session. */
export interface ConnectedClient {
  /** Retrieve one catalog page, optionally continuing from the preceding cursor. */
  listTools(params?: { cursor?: string }): Promise<ListToolsResult>;
  /** Invoke a discovered tool and return its protocol result, including application-level errors. */
  callTool(params: {
    name: string;
    arguments: Record<string, unknown>;
    _meta?: Record<string, unknown>;
  }): Promise<CallToolResult>;
}

/** Remote counterparts of the original functions, preserving object keys or tuple positions. */
export type BoundFunctions<F> = F extends readonly ApiFunction[]
  ? { readonly [K in keyof F]: RemoteFunction<F[K]> }
  : {
      readonly [K in keyof F as K extends string | number
        ? F[K] extends ApiFunction
          ? K
          : never
        : never]: RemoteFunction<F[K]>;
    };

/** Read every catalog page and return typed functions under tools. Named contracts take precedence. Otherwise auto negotiates compact bytes with DSON fallback. Tool errors reject the call. The caller owns the connected transport. */
export async function getMcpClient<Api extends McpApi<object>>(
  client: ConnectedClient,
  options: { codec?: 'auto' | 'dson' } = {},
): Promise<{ tools: BoundFunctions<FunctionsOf<Api>> }> {
  const methods: Record<string, ApiFunction> = Object.create(null);
  const tuple: ApiFunction[] = [];
  const seenCursors = new Set<string>();
  const slots = new Map<number, ApiFunction>();
  let cursor: string | undefined;
  let shape: 'array' | 'object' | undefined;
  do {
    const page = await client.listTools(cursor ? { cursor } : undefined);
    const declared = page._meta?.[collectionKey];
    if (declared !== undefined) {
      if ((declared !== 'array' && declared !== 'object') || (shape && shape !== declared))
        throw new TypeError('Inconsistent MCP function collection.');
      shape = declared;
    }
    for (const tool of page.tools) {
      const key = tool._meta?.[bindingKey];
      if (key === undefined) continue;
      const order = tool._meta?.[namedKey] as Pick<FunctionContract, 'parameters' | 'rest'> | undefined;
      const named =
        order &&
        makeContractCodec(
          {
            ...order,
            inputSchema: tool.inputSchema as FunctionContract['inputSchema'],
            outputSchema: tool.outputSchema as unknown as FunctionContract['outputSchema'],
          },
          'client',
        );
      const compact = options.codec !== 'dson' && tool._meta?.[compactKey] === true;
      const invoke = async (...args: unknown[]) => {
        const input = named
          ? named.encodeArgs(args)
          : compact
            ? packArguments(args)
            : { dson: DSON.stringify({ args }) };
        const result = await client.callTool({
          name: tool.name,
          arguments: input,
          ...(compact && 'dson' in input ? { _meta: { [compactKey]: true } } : {}),
        });
        if (result.isError) {
          const message = result.content?.find((part) => part.type === 'text');
          throw new Error(message?.text ?? 'MCP function call failed.');
        }
        const payload = result.structuredContent;
        if (named) return named.decodeResult(payload);
        if (compact && payload && typeof payload === 'object') {
          if ('bytes' in payload) return decodeBytes(payload);
          if ('packed' in payload) return unpackValue(payload.packed);
          if ('value' in payload) return payload.value;
        }
        if (
          !payload ||
          typeof payload !== 'object' ||
          !('dson' in payload) ||
          typeof payload.dson !== 'string'
        )
          throw new TypeError('Expected a DSON function result from ' + tool.name);
        return DSON.parse(payload.dson);
      };
      if (typeof key === 'number' && Number.isSafeInteger(key) && key >= 0 && !slots.has(key))
        slots.set(key, invoke);
      else if (typeof key === 'string' && key === tool.name && !Object.hasOwn(methods, key))
        methods[key] = invoke;
      else throw new TypeError('Invalid or duplicate function binding for ' + tool.name);
    }
    cursor = page.nextCursor;
    if (cursor && seenCursors.has(cursor)) throw new Error('Repeated MCP tools/list cursor.');
    if (cursor) seenCursors.add(cursor);
  } while (cursor);
  for (let i = 0; i < slots.size; i++) {
    const fn = slots.get(i);
    if (!fn) throw new TypeError('Incomplete MCP function tuple.');
    tuple.push(fn);
  }
  if (
    ((shape === 'array' || slots.size) && Object.keys(methods).length) ||
    (shape === 'object' && slots.size)
  )
    throw new TypeError('Mixed object and array function bindings.');
  // Keep the facade nested: an application may legitimately export a function named "then".
  return { tools: (shape === 'array' || slots.size ? tuple : methods) as BoundFunctions<FunctionsOf<Api>> };
}
