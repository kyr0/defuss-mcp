/** VERIFIED: Handlers share compiled schemas and descriptors. SDK transport state stays local to each factory instance. */
import {
  observeCalls,
  processValue,
  type CallObserver,
  type ObserverErrorHandler,
  type CallProcessors,
  type ProcessingCall,
} from './hooks.js';
export type {
  CallEvent,
  CallObserver,
  ObserverErrorHandler,
  ProcessingCall,
  CallProcessor,
  CallProcessors,
} from './hooks.js';
import {
  contractOf,
  namedKey,
  makeContractCodec,
  ContractIssue,
  asInputSchema,
  type FunctionContract,
} from './contracts.js';
export { bindContract, type FunctionContract, type WireSchema } from './contracts.js';
import { DSON } from 'defuss-dson';
import { ProtocolError, ProtocolErrorCode, Server } from '@modelcontextprotocol/server';
import type {
  CallToolRequest,
  ServerContext,
  CallToolResult,
  Implementation,
  McpServerFactory,
  Tool,
  ToolAnnotations as SdkToolAnnotations,
} from '@modelcontextprotocol/server';

import {
  bindingKey,
  collectionKey,
  callFunction,
  functionEntries,
  positionalSchema,
  type ApiFunction,
} from './functions.js';

import {
  bytesSchema,
  checkByteLimit,
  compactKey,
  decodeBytes,
  defaultByteLimit,
  encodeBytes,
  packValue,
  unpackArguments,
} from './binary.js';
export { encodeBytes, decodeBytes } from './binary.js';

declare const functionContract: unique symbol;
/** Registry carrying the original function collection as a type parameter for remote inference. */
export type McpApi<Functions extends object> = ToolRegistry & { readonly [functionContract]: Functions };
/** Recover the registered object or tuple from the type of a server API. */
export type FunctionsOf<Api> = Api extends McpApi<infer Functions> ? Functions : never;

/** MCP tool inputs have object roots. Nested properties may use the selected JSON Schema dialect. */
export type InputSchema = Tool['inputSchema'] & { type: 'object' };
/** One actionable input error. The path is an RFC 6901 JSON pointer, with an empty string for the root. */
export interface Correction {
  /** Escaped JSON pointer to the offending field. */
  path: string;
  /** Failed constraint such as required, type or contentEncoding. */
  keyword: string;
  /** Action the caller can take before retrying. */
  instruction: string;
  /** Validator-provided parameters for the failed constraint, when available. */
  expected?: unknown;
}
/** Compile once at registration. A successful check allocates no issue list. */
export type CompileSchema = (schema: InputSchema) => (value: unknown) => readonly Correction[] | undefined;
/** Per-call state shared with application handlers and trusted value processors. */
export interface ToolContext {
  /** Originating HTTP request, including authentication headers. Absent on stdio. */
  readonly request?: Request;
  /** Aborts with the MCP request. Pass it to downstream I/O to release work on cancellation. */
  readonly signal: AbortSignal;
  /** Send progress if the caller supplied a progress token. Delivery depends on the response transport. */
  progress(completed: number, total?: number, message?: string): Promise<void>;
}
type Handler<T> = (input: T, context: ToolContext) => unknown;
type Arguments = Record<string, unknown>;
/** MCP behavior hints for hosts: title, readOnlyHint, destructiveHint, idempotentHint and openWorldHint. */
export type ToolAnnotations = SdkToolAnnotations;
/** What tools/list tells hosts and agents about one tool besides its schemas. */
export interface ToolMetadata {
  /** Display name for host interfaces. The tool name stays the wire identifier. */
  title?: string;
  /** Human-readable purpose shown by tools/list. */
  description?: string;
  /** Behavior hints such as readOnlyHint or destructiveHint. Hosts may use them to decide on confirmation prompts. */
  annotations?: ToolAnnotations;
}
/** Registration metadata and per-tool validation policy. */
export interface ToolOptions extends ToolMetadata {
  /** Defaults to validating when a compiler is installed. True requires a compiler, false skips it. Applies to input and declared output. */
  validate?: boolean;
  /** JSON Schema of the handler result. tools/list advertises it under the value field, and an installed compiler checks each result. */
  outputSchema?: Record<string, unknown>;
}
/** Application-owned schema compilation and private diagnostic callbacks. */
export interface RegistryOptions {
  /** Called when registering a JSON or named schema. Keep the returned validator synchronous. */
  compile?: CompileSchema;
  /** Receives unexpected handler errors and the tool name. Clients receive a generic error. */
  onError?: (error: unknown, toolName: string) => void;
  /** Title, description and annotations for registered functions, keyed by wire name. An unknown name fails registration. */
  metadata?: Record<string, ToolMetadata>;
}
function describe(name: string, meta: ToolMetadata = {}) {
  return {
    name,
    title: meta.title,
    description: meta.description,
    annotations: meta.annotations && structuredClone(meta.annotations),
  };
}
interface Entry {
  descriptor: Tool;
  run: (
    args: Arguments,
    context: ToolContext,
    compactReply?: boolean,
    processors?: CallProcessors,
  ) => Promise<CallToolResult>;
}

/** Throw only messages intended for the calling agent. Other exceptions stay private. */
export class ToolFault extends Error {}
const dsonSchema: InputSchema = {
  type: 'object',
  properties: { dson: { type: 'string', description: 'JSON text produced by DSON.stringify' } },
  required: ['dson'],
  additionalProperties: false,
};
/** Serialize a native value or cyclic graph into the single dson string field accepted by a DSON tool. */
export function encodeDson<T>(value: T): { dson: string } {
  return { dson: DSON.stringify(value) };
}
/** Restore a DSON envelope. T expresses the shared TypeScript contract. Malformed envelopes or text throw. */
export function decodeDson<T>(envelope: unknown): T {
  if (
    typeof envelope !== 'object' ||
    envelope === null ||
    !('dson' in envelope) ||
    typeof envelope.dson !== 'string'
  ) {
    throw new TypeError('Expected an MCP object with a dson string.');
  }
  return DSON.parse(envelope.dson) as T;
}
function failure(message: string, details?: Record<string, unknown>): CallToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text: message }],
    structuredContent: { message, ...details },
  };
}

/** One immutable catalog per serving registry. SDK connection state stays request-local. */
export class ToolRegistry {
  readonly #entries = new Map<string, Entry>();
  readonly #identity: Implementation;
  readonly #options: RegistryOptions;
  #catalog?: Tool[];
  #observe?: ReturnType<typeof observeCalls>;
  #processors?: CallProcessors;

  /** Install one metadata sink for all transports before serving. Awaiting it provides backpressure. */
  observeCalls(listener: CallObserver, onError?: ObserverErrorHandler): this {
    if (this.#catalog) throw new Error('Configure call hooks before creating a transport.');
    this.#observe = observeCalls(listener, onError);
    return this;
  }

  /** Install awaited before/after processors before serving. Return { value } to replace decoded input or successful output. Exceptions follow normal tool error handling. */
  processCalls(processors: CallProcessors): this {
    if (this.#catalog) throw new Error('Configure call hooks before creating a transport.');
    this.#processors = { ...processors };
    return this;
  }
  #collection: 'array' | 'object' = 'object';

  /** Create a mutable catalog with an SDK server identity. The first factory or transport freezes registration. */
  constructor(identity: Implementation, options: RegistryOptions = {}) {
    this.#identity = { ...identity };
    this.#options = options;
  }

  #add(name: string, entry: Entry) {
    if (this.#catalog) throw new Error('Register tools before creating a transport.');
    if (!/^[A-Za-z0-9_.-]{1,128}$/.test(name)) throw new Error('Invalid MCP tool name: ' + name);
    if (this.#entries.has(name)) throw new Error('Duplicate MCP tool: ' + name);
    this.#entries.set(name, entry);
    return this;
  }

  /** Register an object-root JSON Schema and handler. Inputs failing the configured validator return pointer-based corrections before invocation. Results use the value field. */
  json<T = Arguments>(name: string, schema: InputSchema, handler: Handler<T>, options: ToolOptions = {}) {
    const inputSchema = structuredClone(schema);
    if (inputSchema.type !== 'object') throw new Error('Tool inputSchema requires an object root.');
    if (options.validate === true && !this.#options.compile)
      throw new Error('Supply a schema compiler to enable validation.');
    const check = options.validate === false ? undefined : this.#options.compile?.(inputSchema);
    const outputSchema =
      options.outputSchema &&
      ({
        type: 'object',
        properties: { value: structuredClone(options.outputSchema) },
        required: ['value'],
        additionalProperties: false,
      } as InputSchema);
    const checkOutput =
      outputSchema && options.validate !== false ? this.#options.compile?.(outputSchema) : undefined;
    return this.#add(name, {
      descriptor: { ...describe(name, options), inputSchema, outputSchema },
      async run(args, context, _compact, processors) {
        const call = processors && { tool: name, kind: 'json' as const, context };
        const input = call && processors?.before ? await processValue(processors.before, call, args) : args;
        const issues = check?.(input);
        if (issues?.length) {
          const steps = issues.map((issue) => (issue.path || '(root)') + ': ' + issue.instruction);
          return failure('Correct the arguments and retry ' + name + '. ' + steps.join('. '), {
            code: 'INVALID_ARGUMENTS',
            issues,
          });
        }
        const result = await handler(input as T, context);
        const value = call && processors?.after ? await processValue(processors.after, call, result) : result;
        if (checkOutput?.({ value })?.length)
          throw new Error('Handler result violates the output schema for ' + name);
        return { content: [], structuredContent: { value } };
      },
    });
  }

  /** Accept a DSON graph through a single string field and encode the result the same way. The application owns the TypeScript contract. */
  dson<T>(name: string, handler: Handler<T>, options: ToolMetadata = {}) {
    return this.#add(name, {
      descriptor: { ...describe(name, options), inputSchema: dsonSchema },
      async run(args, context, _compact, processors) {
        if (typeof args.dson !== 'string' || Object.keys(args).length !== 1)
          return failure('Send exactly one field named dson containing DSON.stringify(input).', {
            code: 'INVALID_DSON',
          });
        let input: T;
        try {
          input = DSON.parse(args.dson) as T;
        } catch {
          return failure('Replace dson with valid defuss-dson text and retry.', { code: 'INVALID_DSON' });
        }
        const call = processors && { tool: name, kind: 'dson' as const, context };
        const argument =
          call && processors?.before ? await processValue(processors.before, call, input) : input;
        const result = await handler(argument as T, context);
        const value = call && processors?.after ? await processValue(processors.after, call, result) : result;
        return { content: [], structuredContent: encodeDson(value) };
      },
    });
  }

  /** Expose bytes to any JSON MCP client, including Python. The decoded limit applies to both directions. */
  binary(
    name: string,
    handler: (bytes: Uint8Array, context: ToolContext) => Uint8Array | Promise<Uint8Array>,
    options: ToolMetadata & { maxBytes?: number } = {},
  ) {
    const limit = options.maxBytes ?? defaultByteLimit;
    checkByteLimit(limit);
    return this.#add(name, {
      descriptor: { ...describe(name, options), inputSchema: bytesSchema },
      async run(args, ctx, _compact, processors) {
        let input: Uint8Array;
        try {
          input = decodeBytes(args, limit);
        } catch (error) {
          return failure((error as Error).message, { code: 'INVALID_BYTES', maxBytes: limit });
        }
        const call = processors && { tool: name, kind: 'binary' as const, context: ctx };
        if (call && processors?.before) {
          const argument = await processValue(processors.before, call, input);
          if (!(argument instanceof Uint8Array) || argument.byteLength > limit)
            throw new ToolFault('Processed binary input must be bytes within the tool byte limit.');
          input = argument;
        }
        const result = await handler(input, ctx);
        const value = call && processors?.after ? await processValue(processors.after, call, result) : result;
        if (!(value instanceof Uint8Array)) throw new TypeError('Expected a binary result.');
        if (value.byteLength > limit) throw new ToolFault('Binary result exceeds the tool byte limit.');
        return { content: [], structuredContent: encodeBytes(value, limit) };
      },
    });
  }

  /** Expose a generated named contract. Decode base64 and restore argument order before invoking the handler. Invalid inputs receive field corrections, invalid results go to onError. */
  named(
    name: string,
    supplied: FunctionContract,
    invoke: Handler<unknown[]>,
    binding?: string | number,
    metadata: ToolMetadata = {},
  ) {
    const contract = structuredClone(supplied);
    const inputSchema = asInputSchema(contract.inputSchema),
      outputSchema = asInputSchema(contract.outputSchema);
    const codec = makeContractCodec(contract, 'server');
    const validate = this.#options.compile?.(inputSchema);
    const checkResult = this.#options.compile?.(outputSchema);
    let nativeCheck: ReturnType<typeof makeContractCodec> | undefined;
    const invalid = (issues: readonly Correction[]) =>
      failure(
        'Correct the arguments and retry ' +
          name +
          '. ' +
          issues.map((i) => (i.path || '(root)') + ': ' + i.instruction).join('. '),
        { code: 'INVALID_ARGUMENTS', issues },
      );
    return this.#add(name, {
      descriptor: {
        ...describe(name, { description: contract.description, ...metadata }),
        inputSchema,
        outputSchema,
        ...(binding === undefined
          ? {}
          : {
              _meta: {
                [bindingKey]: binding,
                [namedKey]: { parameters: contract.parameters, rest: contract.rest },
              },
            }),
      },
      async run(raw, context, _compact, processors) {
        const call = processors && { tool: name, kind: 'function' as const, context };
        let args: unknown[];
        try {
          const issues = validate?.(raw);
          if (issues?.length) return invalid(issues);
          args = codec.decodeArgs(raw);
          if (call && processors?.before) {
            const updated = await processValue(processors.before, call, args);
            if (!Array.isArray(updated))
              throw new ToolFault('Processed function input must be an argument array.');
            const checked = (nativeCheck ??= makeContractCodec(contract, 'client')).encodeArgs(updated);
            const transformed = validate?.(checked);
            if (transformed?.length) return invalid(transformed);
            args = updated;
          }
        } catch (error) {
          if (error instanceof ContractIssue)
            return invalid([{ path: error.path, keyword: error.keyword, instruction: error.instruction }]);
          throw error;
        }
        const result = await invoke(args, context);
        const output = codec.encodeResult(
          call && processors?.after ? await processValue(processors.after, call, result) : result,
        );
        if (checkResult?.(output)?.length)
          throw new Error('Handler result violates the output contract for ' + name);
        return { content: [], structuredContent: output };
      },
    });
  }

  /** Register own module functions or an ordered tuple of named functions as a single batch. */
  static fromFunctions<const Functions extends object>(
    identity: Implementation,
    functions: Functions,
    options?: RegistryOptions,
  ): McpApi<Functions> {
    const registry = new ToolRegistry(identity, options);
    registry.#collection = Array.isArray(functions) ? 'array' : 'object';
    const metadata = options?.metadata ?? {};
    const entries = functionEntries(functions);
    for (const key of Object.keys(metadata))
      if (!entries.some((entry) => entry.name === key))
        throw new Error('Tool metadata names no registered function: ' + key);
    for (const entry of entries) {
      const contract = contractOf(entry.fn);
      const meta = Object.hasOwn(metadata, entry.name) ? metadata[entry.name] : undefined;
      if (contract) {
        registry.named(entry.name, contract, (args, ctx) => callFunction(entry, args, ctx), entry.key, meta);
        continue;
      }
      const descriptor: Tool = {
        ...describe(entry.name, meta),
        inputSchema: positionalSchema,
        _meta: { [bindingKey]: entry.key, [compactKey]: true },
      };
      async function processed(args: unknown[], context: ToolContext, hooks: CallProcessors) {
        const call: ProcessingCall = { tool: entry.name, kind: 'function', context };
        const input = hooks.before ? await processValue(hooks.before, call, args) : args;
        if (!Array.isArray(input)) throw new ToolFault('Processed function input must be an argument array.');
        const result = await callFunction(entry, input, context);
        return hooks.after ? processValue(hooks.after, call, result) : result;
      }
      registry.#add(entry.name, {
        descriptor,
        async run(input, ctx, compactReply, processors) {
          if (Object.hasOwn(input, 'packed') && Object.keys(input).length === 1) {
            let args: unknown[];
            try {
              args = unpackArguments(input.packed);
            } catch (error) {
              return failure((error as Error).message, { code: 'INVALID_ARGUMENTS' });
            }
            return {
              content: [],
              structuredContent: packValue(
                processors ? await processed(args, ctx, processors) : await callFunction(entry, args, ctx),
              ),
            };
          }
          const rich = typeof input.dson === 'string';
          if (Object.keys(input).length !== 1 || (!rich && !Array.isArray(input.args)))
            return failure(
              'Send {args: [...]} in declaration order, or one dson string encoding that object.',
              { code: 'INVALID_ARGUMENTS' },
            );
          let args: unknown = input.args;
          if (rich) {
            try {
              args = decodeDson<{ args: unknown }>(input)?.args;
            } catch {
              return failure('Encode {args: [...]} with DSON.stringify and retry.', { code: 'INVALID_DSON' });
            }
            if (!Array.isArray(args))
              return failure('Supply an args array inside the DSON object.', { code: 'INVALID_ARGUMENTS' });
          }
          const value = processors
            ? await processed(args as unknown[], ctx, processors)
            : await callFunction(entry, args as unknown[], ctx);
          return {
            content: [],
            structuredContent: rich ? (compactReply ? packValue(value) : encodeDson(value)) : { value },
          };
        },
      });
    }
    return registry as McpApi<Functions>;
  }

  /** Publish a group atomically. A failed discovery or name collision leaves this registry intact. */
  async group(register: (staged: ToolRegistry) => void | Promise<void>): Promise<void> {
    const staged = new ToolRegistry(this.#identity, this.#options);
    await register(staged);
    if (staged.#observe || staged.#processors)
      throw new Error('Configure call hooks on the serving registry.');
    if (this.#catalog) throw new Error('Register tools before creating a transport.');
    for (const name of staged.#entries.keys()) {
      if (this.#entries.has(name)) throw new Error('Duplicate MCP tool: ' + name);
    }
    for (const [name, entry] of staged.#entries) this.#entries.set(name, entry);
  }

  /** Freeze the tool list and return an SDK factory. Each invocation creates a separate protocol server with its own request context. */
  factory(): McpServerFactory {
    const catalog = (this.#catalog ??= Array.from(this.#entries.values(), (entry) => entry.descriptor));
    const listing = { tools: catalog, _meta: { [collectionKey]: this.#collection } };
    return ({ requestInfo }) => {
      const server = new Server(this.#identity, { capabilities: { tools: {} } });
      server.setRequestHandler('tools/list', () => listing);
      const dispatch = async (call: CallToolRequest, ctx: ServerContext) => {
        const { name, arguments: args = {} } = call.params;
        const entry = this.#entries.get(name);
        if (!entry) throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Unknown tool: ' + name);
        const token = ctx.mcpReq._meta?.progressToken;
        const context: ToolContext = {
          request: requestInfo,
          signal: ctx.mcpReq.signal,
          async progress(progress, total, message) {
            if (token !== undefined)
              await ctx.mcpReq.notify({
                method: 'notifications/progress',
                params: { progressToken: token, progress, total, message },
              });
          },
        };
        try {
          return server.projectCallToolResult(
            await entry.run(args, context, call.params._meta?.[compactKey] === true, this.#processors),
            entry.descriptor.outputSchema,
          );
        } catch (error) {
          if (error instanceof ToolFault) return failure(error.message);
          try {
            this.#options.onError?.(error, name);
          } catch {
            /* Diagnostics cannot change the wire error. */
          }
          return failure('Tool execution failed.');
        }
      };
      const observe = this.#observe;
      server.setRequestHandler(
        'tools/call',
        observe
          ? (call, ctx) =>
              observe(call.params.name, requestInfo ? 'http' : 'stdio', ctx.mcpReq.signal, () =>
                dispatch(call, ctx),
              )
          : dispatch,
      );
      return server;
    };
  }
}
type FunctionInput<F extends object> = F & (F extends readonly unknown[] ? readonly ApiFunction[] : object);
// Only the two original option names make createMcpApi(identity, options) an empty registry.
type OptionsOnly<F extends object> = Exclude<keyof F, 'compile' | 'onError'> extends never ? true : false;

/** Create a typed MCP registry from an object of functions or a tuple of named functions. Supply an explicit third argument to register functions named only compile or onError. */
export function createMcpApi<const F extends readonly ApiFunction[]>(
  identity: Implementation,
  functions: F,
  options?: RegistryOptions,
): McpApi<F>;
/** Register an object with explicit registry options. Own data methods retain the object as their receiver. Metadata keys must name its functions. */
export function createMcpApi<F extends object>(
  identity: Implementation,
  functions: FunctionInput<F>,
  options: Omit<RegistryOptions, 'metadata'> & { metadata?: { [K in keyof F & string]?: ToolMetadata } },
): McpApi<F>;
/** Infer functions from the object keys. A second argument containing only reserved option keys configures an empty registry. */
export function createMcpApi<F extends object = {}>(
  identity: Implementation,
  functions?: FunctionInput<F> & (OptionsOnly<F> extends true ? RegistryOptions : unknown),
): McpApi<OptionsOnly<F> extends true ? {} : F>;
/** Create an empty registry for manual json, dson, named or binary registrations. */
export function createMcpApi(identity: Implementation, options?: RegistryOptions): McpApi<{}>;
export function createMcpApi(
  identity: Implementation,
  functions: object = {},
  // The object overload narrows metadata keys; every overload passes RegistryOptions at runtime.
  options?: RegistryOptions | object,
): McpApi<object> {
  if (options === undefined && !Array.isArray(functions)) {
    const keys = Object.keys(functions);
    if (keys.length && keys.every((key) => key === 'compile' || key === 'onError')) {
      // Keep existing createMcp(identity, options) call sites valid after a rename.
      for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(functions, key)!;
        if (
          !('value' in descriptor) ||
          (descriptor.value !== undefined && typeof descriptor.value !== 'function')
        )
          throw new TypeError('Invalid registry option: ' + key);
      }
      return ToolRegistry.fromFunctions(identity, {}, functions as RegistryOptions);
    }
  }
  return ToolRegistry.fromFunctions(identity, functions, options as RegistryOptions | undefined);
}
/** Create an empty registry for explicit tool registration.
 * @deprecated Use createMcpApi(identity, functions, options). */
export function createMcp(identity: Implementation, options?: RegistryOptions) {
  return new ToolRegistry(identity, options);
}
